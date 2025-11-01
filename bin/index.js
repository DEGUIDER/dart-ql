#!/usr/bin/env node

/**
 * dart-ql CLI
 *
 * A small utility for generating GraphQL fragments and Dart models
 * used in Ferry / Flutter projects.
 */

const { program } = require('commander');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const pkg = require('../package.json');
const { generateGQLFiles } = require('../src/generator');

// --- CLI Configuration -------------------------------------------------------

program
    .name('dart-ql')
    .aliases(['dartql'])
    .description('Generate GraphQL fragments and Dart models for Ferry/Flutter projects')
    .version(pkg.version)
    .option('-s, --schema <path>', 'Path to a local GraphQL schema file')
    .option('-u, --from-url <url>', 'Download schema from a GraphQL endpoint (e.g. http://localhost:4001/graphql)')
    .option('-o, --out <path>', 'Output directory for generated files')
    .option('-b, --build-runner', 'Run Flutter build_runner after file generation')
    .option('-r, --raw', 'Generate gql files without filtering (includes connections, edges, filters)');

program.parse(process.argv);
const options = program.opts();

// --- Determine Output Paths --------------------------------------------------

const outputDir = options.out
    ? path.resolve(options.out)
    : path.join(process.cwd(), 'lib', 'core', 'graphql');

let schemaPath = options.schema;

// --- Handle Remote Schema Fetching -------------------------------------------

if (options.fromUrl) {
    const schemaFilePath = path.join(outputDir, 'schema.gql');
    console.log(`🌐 Fetching schema from: ${options.fromUrl}`);

    try {
        // Make sure the output directory exists before saving the schema
        fs.mkdirSync(outputDir, { recursive: true });

        // Use get-graphql-schema to pull down the schema and write it to a file
        execSync(`npx get-graphql-schema ${options.fromUrl} > "${schemaFilePath}"`, {
            stdio: 'inherit',
        });

        console.log(`✅ Schema downloaded successfully → ${schemaFilePath}`);
        schemaPath = schemaFilePath;
    } catch (error) {
        console.error(`❌ Failed to download schema: ${error.message}`);
        process.exit(1);
    }
}

// --- Validate Schema Path ----------------------------------------------------

if (!schemaPath) {
    console.error('❌ Missing schema. Please provide one using --schema <path> or --from-url <url>.');
    process.exit(1);
}

// --- Step 1: Generate GraphQL Files ------------------------------------------

generateGQLFiles(schemaPath, outputDir, { raw: options.raw });

// --- Step 2: Optionally Run Flutter Build Runner -----------------------------

if (options.buildRunner) {
    console.log('🚀 Running Flutter build_runner...');

    try {
        execSync(
            'flutter pub run build_runner clean && flutter pub run build_runner build --delete-conflicting-outputs',
            { stdio: 'inherit' }
        );
        console.log('✅ Flutter build_runner finished successfully.');
    } catch (error) {
        console.error(`❌ Error while running build_runner: ${error.message}`);
    }
}
