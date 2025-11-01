const fs = require("fs-extra");
const {
  parse,
  buildASTSchema,
  isNonNullType,
  isListType,
  isScalarType,
} = require("graphql");
const path = require("path");

// Flag for raw generation mode
const RAW_MODE = process.argv.includes("-r") || process.argv.includes("--raw");

/**
 * Converts a string to kebab-case.
 */
function toKebabCase(str) {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Recursively unwraps a type to its base type name.
 */
function unwrapTypeName(type) {
  let t = type;
  while (t.ofType) t = t.ofType;
  return t.name;
}

/**
 * Formats GraphQL types into a readable type string (with [] and !).
 */
function formatTypeString(type) {
  if (isNonNullType(type)) return `${formatTypeString(type.ofType)}!`;
  if (isListType(type)) return `[${formatTypeString(type.ofType)}]`;
  return type.name;
}

/* -------------------------------------------------------------------------- */
/* FRAGMENT HANDLING */
/* -------------------------------------------------------------------------- */

/**
 * Generates fields for a fragment recursively, including interface/union cases.
 */
function generateFragmentFields(type, schema, depth = 0, seen = new Set(), parentPath = "", globalFieldPaths = new Map()) {
  if (!type.getFields) return [];
  if (depth > 5) return []; // prevent infinite recursion

  const fields = Object.values(type.getFields());
  const result = [];

  // Collect interface field names for de-duplication
  const ifaceFieldNames = new Set();
  try {
    const interfaces = typeof type.getInterfaces === "function" ? type.getInterfaces() : [];
    for (const iface of interfaces) {
      if (iface?.getFields) {
        Object.keys(iface.getFields()).forEach(name => ifaceFieldNames.add(name));
      }
    }
  } catch (_) { }

  // Handle implemented interfaces
  if (typeof type.getInterfaces === "function") {
    const interfaces = type.getInterfaces();
    if (interfaces?.length) {
      for (const iface of interfaces) {
        if (!iface?.name) continue;
        result.push(`...${iface.name.charAt(0).toLowerCase() + iface.name.slice(1)}Fragment`);
      }
    }
  }

  // Process each field on the type
  for (const field of fields) {
    const fieldName = field.name;
    const fieldTypeName = unwrapTypeName(field.type);
    const nestedType = schema.getType(fieldTypeName);
    const fullPath = parentPath ? `${parentPath}.${fieldName}` : fieldName;

    const IGNORED_DUPLICATES = new Set(["nodes", "pageInfo", "totalCount"]);

    // Warn on duplicate fields for better debugging
    if (!IGNORED_DUPLICATES.has(fieldName)) {
      if (globalFieldPaths.has(fieldName)) {
        console.warn(
          `⚠️ Duplicate field: '${fieldName}' at '${fullPath}' (previous: '${globalFieldPaths.get(fieldName)}')`
        );
      } else {
        globalFieldPaths.set(fieldName, fullPath);
      }
    }

    if (seen.has(fieldTypeName)) continue;
    if (ifaceFieldNames.has(fieldName)) continue;
    if (fieldTypeName === "ConnectionCursor") continue;

    // Handle interface or union field types
    if (nestedType?.astNode?.kind === "InterfaceTypeDefinition" || nestedType?.astNode?.kind === "UnionTypeDefinition") {
      const possibleTypes = schema.getPossibleTypes?.(nestedType) || [];
      const inlineFragments = possibleTypes
        .map(pt => `... on ${pt.name} { ...${pt.name.charAt(0).toLowerCase() + pt.name.slice(1)}Fragment }`)
        .join("\n    ");
      result.push(`${fieldName} {\n    ${inlineFragments}\n  }`);
      continue;
    }

    // Regular nested fragments (non-scalar)
    if (nestedType && nestedType.getFields && !isScalarType(nestedType)) {
      const fragName = `${fieldTypeName.charAt(0).toLowerCase() + fieldTypeName.slice(1)}Fragment`;
      if (!/Filter|Edge|Connection|PageInfo|Sort/.test(fieldTypeName)) {
        result.push(`${fieldName} {\n    ...${fragName}\n  }`);
        continue;
      }
    }

    // Fallback for nested or scalar fields
    if (nestedType?.getFields && !isScalarType(nestedType)) {
      seen.add(fieldTypeName);
      const subFields = generateFragmentFields(nestedType, schema, depth + 1, seen, fullPath, globalFieldPaths);
      const body = subFields.length ? `{\n    ${subFields.join("\n    ")}\n  }` : "";
      result.push(`${fieldName} ${body}`);
    } else {
      result.push(fieldName);
    }
  }

  return result;
}

/**
 * Builds a complete GraphQL fragment string for a given type.
 */
function generateFragment(typeName, schema) {
  const type = schema.getType(typeName);
  if (!type?.getFields) return "";
  const fields = generateFragmentFields(type, schema);
  if (!fields.length) return "";
  const fragName = `${typeName.charAt(0).toLowerCase() + typeName.slice(1)}Fragment`;
  return `fragment ${fragName} on ${typeName} {\n  ${fields.join("\n  ")}\n}`;
}

/**
 * Unwraps a type recursively to its innermost layer.
 */
function unwrapType(t) {
  while (t?.ofType) t = t.ofType;
  return t;
}

/**
 * Picks a minimal set of scalar fields for a type — used when resolving fragment cycles.
 */
function getMinimalScalarFields(typeName, schema) {
  const t = schema.getType(typeName);
  if (!t?.getFields) return ["id"];

  const scalarFields = Object.values(t.getFields())
    .filter(f => isScalarType(unwrapType(f.type)))
    .map(f => ({
      name: f.name,
      nonNull: isNonNullType(f.type) || (f.type.ofType && isNonNullType(f.type.ofType)),
    }));

  // Simple scoring to prioritize key fields
  const score = f => {
    let s = 0;
    if (f.nonNull) s += 2;
    if (/id|name|title|email|type/i.test(f.name)) s += 1;
    if (f.name.length <= 5) s += 0.5;
    return s;
  };

  scalarFields.sort((a, b) => score(b) - score(a));

  const nonNull = scalarFields.filter(f => f.nonNull).map(f => f.name);
  const nullable = scalarFields.filter(f => !f.nonNull).map(f => f.name);
  const selected = [...nonNull, ...nullable.slice(0, 3)];

  return selected.length ? selected : ["id"];
}

/* -------------------------------------------------------------------------- */
/* OPERATION HANDLING */
/* -------------------------------------------------------------------------- */

function generateArgsString(args, inputs) {
  if (!args || !args.length) return { vars: "", args: "" };

  const vars = [];
  const argAssignments = [];

  for (const arg of args) {
    if (!arg?.type) continue;
    const argTypeName = unwrapTypeName(arg.type);
    if (argTypeName === "ConnectionCursor") continue;

    const inputType = inputs[argTypeName];
    if (inputType?.getFields && arg.name.toLowerCase() === "input") {
      vars.push(`$${arg.name}: ${formatTypeString(arg.type)}`);
      argAssignments.push(`${arg.name}: $${arg.name}`);
      continue;
    }

    vars.push(`$${arg.name}: ${formatTypeString(arg.type)}`);
    argAssignments.push(`${arg.name}: $${arg.name}`);
  }

  if (!vars.length) return { vars: "", args: "" };
  return { vars: `(${vars.join(", ")})`, args: `(${argAssignments.join(", ")})` };
}

function generateOperation(opType, opName, fieldName, field, returnTypeName, inputs) {
  let innerType = field.type;
  while (innerType.ofType) innerType = innerType.ofType;

  const simpleReturn =
    isScalarType(innerType) ||
    innerType.astNode?.kind === "EnumTypeDefinition" ||
    ["Boolean", "Int", "Float", "ID", "String"].includes(innerType.name);

  const { vars, args } = generateArgsString(field.args || [], inputs);

  if (simpleReturn) {
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
    const rootMatch = body.match(/([a-zA-Z0-9_]+)\s*(\([^\)]*\))?/);
    const rootField = rootMatch ? rootMatch[1] : null;

    if (rootField === fieldName) {
      foundExisting = true;

      const newVars = newOpStr.match(/\(([^)]*)\)/);
      const varsStr = newVars ? `(${newVars[1]})` : "";
      const hasFragments = /\{\s*\.\.\.[A-Za-z0-9_]+/.test(newOpStr);

      if (!hasFragments) {
        updatedContent = existingContent.replace(
          full,
          `${type} ${name}${varsStr} {\n  ${fieldName}${rootMatch?.[2] || ""}\n}`
        );
      } else {
        const newFrags = newOpStr.match(/\.\.\.[A-Za-z0-9_]+/g) || [];
        const existingFrags = body.match(/\.\.\.[A-Za-z0-9_]+/g) || [];
        const merged = Array.from(new Set([...existingFrags, ...newFrags]));
        const mergedBody = `  ${fieldName}${rootMatch?.[2] || ""} {\n    ${merged.join("\n    ")}\n  }`;
        updatedContent = existingContent.replace(full, `${type} ${name}${varsStr} {\n${mergedBody}\n}`);
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
    if (type.astNode?.kind === "InputObjectTypeDefinition") inputs[type.name] = type;
  }

  const existingOps = mapExistingOperations(documentsDir);
  const seenOps = new Set();

  const skipPattern = /Filter|Edge|Connection|PageInfo|OffsetPageInfo|Sort/;
  const skipCrud = /^(createOne|updateOne|deleteOne|upsertOne|aggregate|findMany|groupBy)/;

  const operations = [];

  for (const [opType, typeDef] of [
    ["query", queryType],
    ["mutation", mutationType],
    ["subscription", subscriptionType],
  ]) {
    if (!typeDef) continue;

    for (const [fieldName, field] of Object.entries(typeDef.getFields())) {
      const returnTypeName = unwrapTypeName(field.type);
      if (skipPattern.test(returnTypeName)) continue;
      if (!RAW_MODE && skipCrud.test(fieldName)) continue;
      operations.push({ opType, fieldName, field, returnTypeName });
    }
  }

  // Generate or update operations
  for (const { opType, fieldName, field, returnTypeName } of operations) {
    if (seenOps.has(fieldName)) continue;
    seenOps.add(fieldName);

    const existing = existingOps[fieldName];
    const opName = existing?.opName || fieldName;
    const targetFile = existing
      ? path.join(documentsDir, existing.file)
      : path.join(documentsDir, `${toKebabCase(returnTypeName)}.gql`);

    const newOpStr = generateOperation(opType, opName, fieldName, field, returnTypeName, inputs);
    const existingContent = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf8") : "";
    const updated = mergeOperation(existingContent, newOpStr, fieldName);
    fs.writeFileSync(targetFile, updated.trim() + "\n");
  }

  /* Fragment generation with cycle detection and fallback inlining */

  const skipRoot = [queryType?.name, mutationType?.name, subscriptionType?.name];
  const rawFragments = {};
  const fragmentDeps = {};

  // Generate raw fragments
  for (const typeName of Object.keys(typeMap)) {
    const type = typeMap[typeName];
    if (
      !type?.getFields ||
      type.name.startsWith("__") ||
      skipRoot.includes(typeName) ||
      skipPattern.test(typeName) ||
      ["InputObjectTypeDefinition", "EnumTypeDefinition", "UnionTypeDefinition"].includes(type.astNode?.kind)
    ) continue;

    const fragment = generateFragment(typeName, schema);
    if (!fragment) continue;

    rawFragments[typeName] = fragment;
    const deps = [...fragment.matchAll(/\.\.\.([a-zA-Z0-9_]+)Fragment/g)].map(m => m[1]);
    fragmentDeps[typeName] = deps;
  }

  // Detect simple cycles (A ↔ B)
  const cycles = [];
  for (const [a, depsA] of Object.entries(fragmentDeps)) {
    for (const b of depsA || []) {
      if ((fragmentDeps[b] || []).includes(a)) cycles.push([a, b]);
    }
  }

  // Handle cycles by inlining one fragment into the other
  if (cycles.length) {
    console.warn("⚠️ Fragment cycles detected, resolving...");
    const handled = new Set();

    for (const [a, b] of cycles) {
      const key = [a, b].sort().join("-");
      if (handled.has(key)) continue;
      handled.add(key);

      console.warn(`  Found cycle: ${a} ↔ ${b}`);

      const aScore = (rawFragments[a]?.split("\n").length || 0) + (fragmentDeps[a]?.length || 0);
      const bScore = (rawFragments[b]?.split("\n").length || 0) + (fragmentDeps[b]?.length || 0);
      const inlineTarget = aScore < bScore ? a : b;
      const inlineSource = inlineTarget === a ? b : a;

      console.warn(`  → Inlining ${inlineSource} inside ${inlineTarget}`);

      fragmentDeps[inlineTarget] = (fragmentDeps[inlineTarget] || []).filter(d => d !== inlineSource);

      const inlineFields = getMinimalScalarFields(inlineSource, schema);
      const targetFields = rawFragments[inlineTarget]?.match(/\b([a-zA-Z0-9_]+)\b/g) || [];
      const duplicates = new Set(inlineFields.filter(f => targetFields.includes(f)));

      const inlineBody = inlineFields.map(f => {
        if (f !== "id" && duplicates.has(f)) {
          const alias = `${inlineSource.charAt(0).toLowerCase() + inlineSource.slice(1)}${f.charAt(0).toUpperCase() + f.slice(1)}`;
          return `  ${alias}: ${f}`;
        }
        return `  ${f}`;
      }).join("\n");

      const fragPattern = new RegExp(
        `\\.\\.\\.\\s*${inlineSource.charAt(0).toLowerCase() + inlineSource.slice(1)}Fragment`,
        "g"
      );

      rawFragments[inlineTarget] = rawFragments[inlineTarget].replace(fragPattern, inlineBody);
    }
  }

  // Write all generated fragments to files
  for (const [typeName, fragment] of Object.entries(rawFragments)) {
    fs.writeFileSync(
      path.join(fragmentsDir, `${toKebabCase(typeName)}.fragment.gql`),
      fragment.trim() + "\n"
    );
  }

  console.log(`✅ Generated GraphQL fragments and operations in ${outDir} ${RAW_MODE ? "(raw mode)" : ""}`);
}

module.exports = { generateGQLFiles };
