<br>

##   🎯 dart-ql

> Generate **GraphQL fragments** and **Dart models** for your Flutter projects — automatically.

[![npm version](https://img.shields.io/npm/v/dart-ql.svg?color=blue)](https://www.npmjs.com/package/dart-ql)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](https://nodejs.org)

`dart-ql` is a Node.js CLI tool that reads your **GraphQL schema** and generates:
- ✅ `.gql` operation documents (queries, mutations, subscriptions)
- ✅ Reusable `.fragment.gql` files
- ✅ Compatible structure for **Ferry**, **Artemis**, and **graphql_codegen** Flutter clients  
- ⚡ Optionally runs `flutter pub run build_runner build` automatically

---

##   🚀 Installation

You can install globally:

```
npm install -g dart-ql
```

Or use pnpm / yarn if you prefer:

```
pnpm add -g dart-ql
# or
yarn global add dart-ql
```

## 🧹 Uninstallation

To remove it from your system:
```
npm uninstall -g dart-ql
```

Or using your preferred package manager:
```
pnpm remove -g dart-ql
# or
yarn global remove dart-ql
```

##   🧰 Usage

You can use either
```
dart-ql
```
Or 
```
dartql
```

to run it.


You can either generate from a local schema file
```
dart-ql --schema ./graphql/schema.graphql --out ./lib/core/graphql
```

Or generate using a schema from a GraphQL endpoint through a url
```
dart-ql --from-url http://localhost:4000/graphql --out ./lib/core/graphql
```

This will:

Download your remote schema

Generate all fragments & operation documents under lib/core/graphql/

Skip repetitive GraphQL boilerplate

After first generation you can change, move queries, mutations and subscriptions to  other files and dart-ql will keep it like that. e.g:
```
if it generates an admin.gql and an admin-role.gql and the latter only contains one query, you can move that query to admin.gql and delete admin-role.gql and in the next generation it will keep it like that, it will still update the queries if something changes but it will keep it inside admin.gql, I hope this is clear haha.
```

## ⚙️ Options
Option	Alias	Description
```
--schema <path>	-s	Path to a local .graphql schema file
--from-url <url>	-u	Download schema dynamically from an endpoint
--out <path>	-o	Output folder for generated .gql files
--build-runner	-b	Automatically run Flutter build_runner after generation
--raw	-r	Generate all fragments (including connections, edges, filters)
```
Example:

dart-ql -u https://graphqlplaceholder.vercel.app/graphql -o ./lib/core/graphql 

##   🏗️ Example Output Structure
```
lib/core/graphql/
 ├─ fragments/
 │   ├─ user.fragment.gql
 │   ├─ message.fragment.gql
 │   └─ product.fragment.gql
 ├─ documents/
 │   ├─ user.gql
 │   ├─ admin.gql
 │   └─ product.gql
 └─ schema.gql
```

Each file contains optimized GraphQL operations and reusable fragments.

## 🔄 Integration with Flutter

- Once generated, you can run:

flutter pub run build_runner build --delete-conflicting-outputs to generate the .gql.dart files that contain the graphql variables and options




If you pass --build-runner OR -b , dart-ql can run that for you automatically after the gql files are generated (not recommended, always make sure to double check if the gql files are correct).

##   🧩 Why dart-ql?

🧩 Eliminates manual operation and fragment writing (by operations, I am refering to queries, mutations and subscriptions) 

⚡ if two fields share the same name, it creates an alias for the inline-field, for example:
```
fragment productFragment on product {
  id
  name
  description
  brand
  color
  condition
  price
  quantity
  type
  images { ...mediaFragment }
  user {
    id
    firstName
    lastName
    userName
    mobileNumber
    email
    gender
    userType: type ## created an alias to avoid having two fields named type, cause sometimes it might cause an issue when creating a dart extension to convert gql type to dart model, I will make it optional in the next version.
  }
}
```

🧠 Smartly detects & resolves fragment cycles

🧱 If you make any change to the operations  (querries, mutations, subscriptions) or merge two .gql files together inside the documents folder, the next time you run dart-ql it will not remove them or change them back, it will remember those changes.

🚨 this package's main purpose is to save you time, however currently it will not fully setup your graphql project, you will still need to manually setup your GraphQLProvider, Client and link inside your flutter project.

### 🧪 Requirements

Node.js >= 18

A valid GraphQL schema file or endpoint

Flutter project using build_runner + a GraphQL client


### 🤝 Contributing

Contributions, feedback, and PRs are welcome!
If you find bugs or want to suggest improvements:

Open an issue

Or fork and submit a pull request

### 🗺️ Roadmap

 Add ability for custom fine tuning and customization.

 Make it retain any user changes to fragments even after regeneration like it does with operations.

 Maybe switch to using Typescript instead of Javascript in the future.


### 🧑‍💻 Author

Hadi Badjah - Deguider
GitHub
 · npm

### 🪪 License

This project is licensed under the MIT License.
See the LICENSE
 file for details.
