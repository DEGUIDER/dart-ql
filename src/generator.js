const fs = require("fs-extra");
const {
  parse,
  buildASTSchema,
  isNonNullType,
  isListType,
  isScalarType,
} = require("graphql");
const path = require("path");

const RAW_MODE = process.argv.includes("-r") || process.argv.includes("--raw");

function toKebabCase(str) {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function unwrapTypeName(type) {
  let t = type;
  while (t.ofType) t = t.ofType;
  return t.name;
}

function formatTypeString(type) {
  if (isNonNullType(type)) return `${formatTypeString(type.ofType)}!`;
  if (isListType(type)) return `[${formatTypeString(type.ofType)}]`;
  return type.name;
}

/* -------------------------------------------------------------------------- */
/* 🧩 FRAGMENT HANDLING (updated section only) */
/* -------------------------------------------------------------------------- */

// ---------------- Dynamic Interface/Union Handling ----------------
function generateFragmentFields(type, schema, depth = 0, seen = new Set(), parentPath = "", globalFieldPaths = new Map()) {
  if (!type.getFields) return [];
  if (depth > 5) return []; // avoid infinite recursion

  const fields = Object.values(type.getFields());
  const result = [];

  let ifaceFieldNames = new Set();
  try {
    const interfaces = typeof type.getInterfaces === "function" ? type.getInterfaces() : [];
    for (const iface of interfaces) {
      if (iface && iface.getFields) {
        Object.keys(iface.getFields()).forEach(n => ifaceFieldNames.add(n));
      }
    }
  } catch (_) { }

  if (typeof type.getInterfaces === "function") {
    const interfaces = type.getInterfaces();
    if (interfaces && interfaces.length > 0) {
      for (const iface of interfaces) {
        if (!iface?.name) continue;
        result.push(`...${iface.name.charAt(0).toLowerCase() + iface.name.slice(1)}Fragment`);
      }
    }
  }

  for (const field of fields) {
    const fieldName = field.name;
    const fieldTypeName = unwrapTypeName(field.type);
    const nestedType = schema.getType(fieldTypeName);

    const fullPath = parentPath ? `${parentPath}.${fieldName}` : fieldName;

    const IGNORED_DUPLICATE_FIELDS = new Set(["nodes", "pageInfo", "totalCount"]);
    if (!IGNORED_DUPLICATE_FIELDS.has(fieldName)) {
      if (globalFieldPaths.has(fieldName)) {
        console.warn(
          `⚠️ Duplicate field detected: '${fieldName}' appears at '${fullPath}' and '${globalFieldPaths.get(fieldName)}'`
        );
      } else {
        globalFieldPaths.set(fieldName, fullPath);
      }
    }

    if (seen.has(fieldTypeName)) continue;
    if (ifaceFieldNames.has(fieldName)) continue;
    if (fieldTypeName === "ConnectionCursor") continue;

    // ---------- Dynamic interface/union handling ----------
    if (nestedType?.astNode?.kind === "InterfaceTypeDefinition" || nestedType?.astNode?.kind === "UnionTypeDefinition") {
      const possibleTypes = schema.getPossibleTypes?.(nestedType) || [];
      const inlineFragments = possibleTypes.map(pt => `... on ${pt.name} { ...${pt.name.charAt(0).toLowerCase() + pt.name.slice(1)}Fragment }`).join("\n    ");
      result.push(`${fieldName} {\n    ${inlineFragments}\n  }`);
      continue;
    }

    // normal nested fragment
    if (nestedType && nestedType.getFields && !isScalarType(nestedType)) {
      const fragName = `${fieldTypeName.charAt(0).toLowerCase() + fieldTypeName.slice(1)}Fragment`;
      if (!/Filter|Edge|Connection|PageInfo|Sort/.test(fieldTypeName)) {
        result.push(`${fieldName} {\n    ...${fragName}\n  }`);
        continue;
      }
    }

    // scalar or nested fallback
    if (nestedType?.getFields && !isScalarType(nestedType)) {
      seen.add(fieldTypeName);
      const subfields = generateFragmentFields(nestedType, schema, depth + 1, seen, fullPath, globalFieldPaths);
      const inner = subfields.length ? `{\n    ${subfields.join("\n    ")}\n  }` : "";
      result.push(`${fieldName} ${inner}`);
    } else {
      result.push(fieldName);
    }
  }

  return result;
}

function generateFragment(typeName, schema) {
  const type = schema.getType(typeName);
  if (!type?.getFields) return "";
  const fields = generateFragmentFields(type, schema);
  if (!fields.length) return "";
  const fragName = `${typeName.charAt(0).toLowerCase() + typeName.slice(1)}Fragment`;
  return `fragment ${fragName} on ${typeName} {\n  ${fields.join("\n  ")}\n}`;
}

// helper for scalar fallback
function unwrapType(t) {
  while (t?.ofType) t = t.ofType;
  return t;
}
function getMinimalScalarFields(typeName, schema) {
  const t = schema.getType(typeName);
  if (!t?.getFields) return ["id"];

  // extract all scalar fields
  const scalarFields = Object.values(t.getFields())
    .filter(f => isScalarType(unwrapType(f.type)))
    .map(f => ({
      name: f.name,
      nonNull: isNonNullType(f.type) || (f.type.ofType && isNonNullType(f.type.ofType)),
    }));

  // assign heuristic priority (not hardcoded per type)
  const score = f => {
    let s = 0;
    if (f.nonNull) s += 2;
    if (/id|name|title|email|type/i.test(f.name)) s += 1;
    if (f.name.length <= 5) s += 0.5; // short, likely core field
    return s;
  };

  // sort by score descending
  scalarFields.sort((a, b) => score(b) - score(a));

  // always include all non-nullables + top 3 nullable fields
  const nonNullFields = scalarFields.filter(f => f.nonNull).map(f => f.name);
  const nullableFields = scalarFields.filter(f => !f.nonNull).map(f => f.name);
  const chosen = [...nonNullFields, ...nullableFields.slice(0, 3)];

  return chosen.length ? chosen : ["id"];
}


/* -------------------------------------------------------------------------- */
/* ⬇️ Everything below is restored to your original version (no changes) */
/* -------------------------------------------------------------------------- */

function generateArgsString(args, inputs) {
  if (!args || args.length === 0) return { vars: "", args: "" };

  const vars = [];
  const argAssignments = [];

  for (const a of args) {
    if (!a?.type) continue;
    const argTypeName = unwrapTypeName(a.type);
    if (argTypeName === "ConnectionCursor") continue;

    const inputType = inputs[argTypeName];
    if (inputType && inputType.getFields && a.name.toLowerCase() === "input") {
      vars.push(`$${a.name}: ${formatTypeString(a.type)}`);
      argAssignments.push(`${a.name}: $${a.name}`);
      continue;
    }

    vars.push(`$${a.name}: ${formatTypeString(a.type)}`);
    argAssignments.push(`${a.name}: $${a.name}`);
  }

  if (!vars.length) return { vars: "", args: "" };
  return { vars: `(${vars.join(", ")})`, args: `(${argAssignments.join(", ")})` };
}

function generateOperation(opType, opName, fieldName, field, returnTypeName, inputs) {
  let innerType = field.type;
  while (innerType.ofType) innerType = innerType.ofType;
  const isSimpleReturn =
    isScalarType(innerType) ||
    innerType.astNode?.kind === "EnumTypeDefinition" ||
    ["Boolean", "Int", "Float", "ID", "String"].includes(innerType.name);
  const { vars, args } = generateArgsString(field.args || [], inputs);
  if (isSimpleReturn) {
    return `${opType} ${opName}${vars} {\n  ${fieldName}${args}\n}`;
  }
  const fragName = `${returnTypeName.charAt(0).toLowerCase() + returnTypeName.slice(1)}Fragment`;
  return `${opType} ${opName}${vars} {\n  ${fieldName}${args} {\n    ...${fragName}\n  }\n}`;
}

function mergeOperation(existingContent, newOpStr, fieldName) {
  const opRegex =
    /(query|mutation|subscription)\s+([A-Za-z0-9_]+)\s*(\([^\)]*\))?\s*\{([\s\S]*?)\n\}/gm;

  let foundExisting = false;
  let updatedContent = existingContent;

  while (true) {
    const match = opRegex.exec(existingContent);
    if (!match) break;

    const [full, type, name, vars, body] = match;
    const rootFieldMatch = body.match(/([a-zA-Z0-9_]+)\s*(\([^\)]*\))?/);
    const rootField = rootFieldMatch ? rootFieldMatch[1] : null;

    if (rootField === fieldName) {
      foundExisting = true;

      const newVarsMatch = newOpStr.match(/\(([^)]*)\)/);
      const newVars = newVarsMatch ? `(${newVarsMatch[1]})` : "";
      const hasBraces = /\{\s*\.\.\.[A-Za-z0-9_]+/.test(newOpStr);

      if (!hasBraces) {
        updatedContent = existingContent.replace(
          full,
          `${type} ${name}${newVars} {\n  ${fieldName}${rootFieldMatch?.[2] || ""}\n}`
        );
      } else {
        const newFragMatch = newOpStr.match(/\.\.\.[A-Za-z0-9_]+/g) || [];
        const existingFragMatch = body.match(/\.\.\.[A-Za-z0-9_]+/g) || [];
        const mergedFrags = Array.from(new Set([...existingFragMatch, ...newFragMatch]));
        const mergedBody = `  ${fieldName}${rootFieldMatch?.[2] || ""} {\n    ${mergedFrags.join(
          "\n    "
        )}\n  }`;

        updatedContent = existingContent.replace(
          full,
          `${type} ${name}${newVars} {\n${mergedBody}\n}`
        );
      }
      break;
    }
  }

  if (!foundExisting) updatedContent = existingContent.trim() + "\n\n" + newOpStr + "\n";
  return updatedContent;
}

function mapExistingOperations(documentsDir) {
  const opMap = {};
  if (!fs.existsSync(documentsDir)) return opMap;
  const files = fs.readdirSync(documentsDir).filter(f => f.endsWith(".gql"));
  for (const file of files) {
    const content = fs.readFileSync(path.join(documentsDir, file), "utf8");
    const regex =
      /(query|mutation|subscription)\s+([A-Za-z0-9_]+)\s*(\([^\)]*\))?\s*\{\s*([A-Za-z0-9_]+)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const [, , opName, , fieldName] = match;
      opMap[fieldName] = { opName, file };
    }
  }
  return opMap;
}

function generateGQLFiles(schemaPath, outDir) {
  const schemaSDL = fs.readFileSync(schemaPath, "utf8");
  const schema = buildASTSchema(parse(schemaSDL));
  const typeMap = schema.getTypeMap();

  const queryType = schema.getQueryType();
  const mutationType = schema.getMutationType();
  const subscriptionType = schema.getSubscriptionType();

  const fragmentsDir = path.join(outDir, "fragments");
  const documentsDir = path.join(outDir, "documents");
  fs.ensureDirSync(fragmentsDir);
  fs.ensureDirSync(documentsDir);

  const inputs = {};
  for (const type of Object.values(typeMap)) {
    const kind = type.astNode?.kind;
    if (!kind || type.name.startsWith("__")) continue;
    if (kind === "InputObjectTypeDefinition") inputs[type.name] = type;
  }

  const existingOps = mapExistingOperations(documentsDir);
  const seenOps = new Set();

  const skipPattern = /Filter|Edge|Connection|PageInfo|OffsetPageInfo|Sort/;
  const skipAutoCrud = /^(createOne|updateOne|deleteOne|upsertOne|aggregate|findMany|groupBy)/;

  const operations = [];
  for (const [opTypeName, typeDef] of [
    ["query", queryType],
    ["mutation", mutationType],
    ["subscription", subscriptionType],
  ]) {
    if (!typeDef) continue;
    for (const [fieldName, field] of Object.entries(typeDef.getFields())) {
      const returnTypeName = unwrapTypeName(field.type);
      if (skipPattern.test(returnTypeName)) continue;
      if (!RAW_MODE && skipAutoCrud.test(fieldName)) continue;
      operations.push({ opTypeName, fieldName, field, returnTypeName });
    }
  }

  for (const { opTypeName, fieldName, field, returnTypeName } of operations) {
    if (seenOps.has(fieldName)) continue;
    seenOps.add(fieldName);
    const opInfo = existingOps[fieldName];
    const opName = opInfo?.opName || fieldName;
    const targetFile = opInfo
      ? path.join(documentsDir, opInfo.file)
      : path.join(documentsDir, `${toKebabCase(returnTypeName)}.gql`);
    const newOpStr = generateOperation(opTypeName, opName, fieldName, field, returnTypeName, inputs);
    let existingContent = fs.existsSync(targetFile)
      ? fs.readFileSync(targetFile, "utf8")
      : "";
    const updatedContent = mergeOperation(existingContent, newOpStr, fieldName);
    fs.writeFileSync(targetFile, updatedContent.trim() + "\n");
  }

  /* 🧩 fragment generation logic (cycle detection + fallback) */

  const skipRootTypes = [queryType?.name, mutationType?.name, subscriptionType?.name];

  const rawFragments = {};
  const fragmentDeps = {};

  // Step 1: generate raw fragments and collect dependencies
  for (const typeName of Object.keys(typeMap)) {
    const type = typeMap[typeName];
    if (!type?.getFields) continue;
    if (
      typeName.startsWith("__") ||
      type.astNode?.kind === "InputObjectTypeDefinition" ||
      type.astNode?.kind === "EnumTypeDefinition" ||
      type.astNode?.kind === "UnionTypeDefinition" ||
      skipPattern.test(typeName) ||
      skipRootTypes.includes(typeName)
    )
      continue;

    const fragment = generateFragment(typeName, schema);
    if (!fragment) continue;

    rawFragments[typeName] = fragment;
    const deps = [...fragment.matchAll(/\.\.\.([a-zA-Z0-9_]+)Fragment/g)].map(m => m[1]);
    fragmentDeps[typeName] = deps;
  }

  // Step 2: detect only direct cycles (A ↔ B), not long indirect chains
  const cycles = [];
  for (const [a, depsA] of Object.entries(fragmentDeps)) {
    for (const b of depsA || []) {
      if ((fragmentDeps[b] || []).includes(a)) {
        // found a direct two-way dependency
        cycles.push([a, b]);
      }
    }
  }

  // Step 3: prune direct cycles smartly (prefer keeping the larger fragment)
  if (cycles.length) {
    console.warn("⚠️ Fragment cycles detected, pruning:");
    const handled = new Set();

    for (const [a, b] of cycles) {
      const key = [a, b].sort().join("-");
      if (handled.has(key)) continue;
      handled.add(key);

      console.warn(`  Cycle detected: ${a} ↔ ${b}`);

      // choose which fragment to inline based on size+deps
      const aScore = (rawFragments[a]?.split("\n").length || 0) + (fragmentDeps[a]?.length || 0);
      const bScore = (rawFragments[b]?.split("\n").length || 0) + (fragmentDeps[b]?.length || 0);
      const inlineTarget = aScore < bScore ? a : b;
      const inlineSource = inlineTarget === a ? b : a;

      console.warn(`  → Inlining ${inlineSource} inside ${inlineTarget}`);

      // remove dependency
      fragmentDeps[inlineTarget] = (fragmentDeps[inlineTarget] || []).filter(d => d !== inlineSource);

      // get minimal scalar fields
      const inlineFields = getMinimalScalarFields(inlineSource, schema);

      // determine which ones actually conflict with the target fragment
      const targetFragmentFields = rawFragments[inlineTarget]?.match(/\b([a-zA-Z0-9_]+)\b/g) || [];
      const duplicateFields = new Set(inlineFields.filter(f => targetFragmentFields.includes(f)));

      // build inlined field strings with aliasing only for duplicates (excluding 'id')
      const inlineFieldStrings = inlineFields.map(f => {
        if (f !== "id" && duplicateFields.has(f)) {
          // only alias duplicates and skip 'id'
          const alias = `${inlineSource.charAt(0).toLowerCase() + inlineSource.slice(1)}${f.charAt(0).toUpperCase() + f.slice(1)}`;
          return `  ${alias}: ${f}`;
        }
        return `  ${f}`;
      }).join("\n");


      const fragPattern = new RegExp(
        `\\.\\.\\.\\s*${inlineSource.charAt(0).toLowerCase() + inlineSource.slice(1)}Fragment`,
        "g"
      );

      rawFragments[inlineTarget] = rawFragments[inlineTarget].replace(fragPattern, inlineFieldStrings);
    }
  }


  // Step 4: write all fragments
  for (const [typeName, fragment] of Object.entries(rawFragments)) {
    fs.writeFileSync(
      path.join(fragmentsDir, `${toKebabCase(typeName)}.fragment.gql`),
      fragment.trim() + "\n"
    );
  }


  console.log(
    `✅ Generated GQL fragments and operations in ${outDir} ${RAW_MODE ? "(raw mode)" : ""}`
  );
}

module.exports = { generateGQLFiles };
