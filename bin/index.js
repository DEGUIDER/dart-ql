#!/usr/bin/env node

const { program } = require('commander');
const { generateGQLFiles } = require('../src/generator');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const pkg = require('../package.json');

program
    .name('dart-ql')
    .aliases(['dartql'])
    .description('Generate GraphQL fragments and Dart models for Ferry/Flutter projects')
    .version(pkg.version)
    .option('-s, --schema <path>', 'Path to GraphQL schema file')
    .option('-u, --from-url <url>', 'Download schema from GraphQL endpoint URL e.g: http://localhost:4001/graphql')
    .option('-o, --out <path>', 'Output folder for generated files')
    .option('-b, --build-runner', 'Run Flutter build_runner after generation')
    .option('-r, --raw', "Generate gql files without filtering (includes connections, edge, filters)");

program.parse(process.argv);
const options = program.opts();

const outputDir = options.out
    ? path.resolve(options.out)
    : path.join(process.cwd(), 'lib', 'core', 'graphql');

let schemaPath = options.schema;

// 🟢 If --from-url is provided, fetch schema dynamically
if (options.fromUrl) {
    const schemaFilePath = path.join(outputDir, 'schema.gql');
    console.log(`🌐 Fetching schema from ${options.fromUrl}...`);
    try {
        // Ensure output folder exists
        fs.mkdirSync(outputDir, { recursive: true });

        // Run get-graphql-schema (you can also use curl if needed)
        execSync(`npx get-graphql-schema ${options.fromUrl} > "${schemaFilePath}"`, {
            stdio: 'inherit',
        });

        console.log(`✅ Schema downloaded to ${schemaFilePath}`);
        schemaPath = schemaFilePath;
    } catch (err) {
        console.error(`❌ Failed to download schema: ${err.message}`);
        process.exit(1);
    }
}

// 🟡 Safety: ensure schema path is known
if (!schemaPath) {
    console.error('❌ Please provide a schema path with --schema or use --from-url <url>');
    process.exit(1);
}

// Step 1: Generate .gql files
generateGQLFiles(schemaPath, outputDir, { raw: options.raw });

// Step 2: Optionally run build_runner
if (options.buildRunner) {
    console.log('🚀 Running Flutter build_runner...');
    try {
        execSync(
            'flutter pub run build_runner clean && flutter pub run build_runner build --delete-conflicting-outputs',
            { stdio: 'inherit' }
        );
        console.log('✅ Flutter build_runner completed successfully!');
    } catch (err) {
        console.error('❌ Error running Flutter build_runner:', err.message);
    }
}
