# Contributing

The plugin follows the [plugin standard](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/plugin-standard.md).

```sh
npm ci
npm run typecheck
npm run build
npm test
npx plugin-kit check
```

- Add or change a method in `package.json` `capabilities` first, then the handler in `src/handlers/`, then a test.
- Provider calls belong in `src/provider/`; handlers never call the host's tool, RPC or permission APIs.
- The conformance fixture is written by `test/conformance/record.test.ts`, then redacted with `npx plugin-kit record`.
- Run `npx plugin-kit docs` after changing the manifest, and commit the generated sections.
- Conventional commits. Do not add runtime dependencies, peer dependencies, lifecycle scripts or app names.
