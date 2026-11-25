# Contributing

The plugin follows the [plugin standard](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/plugin-standard.md).

```sh
npm ci
npm run typecheck
npm run bundle
npm test
npx plugin-kit check
```

- `npm run check` runs lint, typecheck, `npm run bundle`, the tests, the kit check and the pack test.
- `dist/index.js` is committed: run `npm run bundle` and commit the result with the source change; CI fails when it drifts.
- Lint is Biome (`biome check .`); warnings are allowed, errors are not.
- `noControlCharactersInRegex` is off: the runtime protocol and redaction regexes match Unicode control and bidi ranges
  on purpose.
- Add or change a method in `package.json` `capabilities` first, then the handler in `src/handlers/`, then a test.
- Provider calls belong in `src/provider/`; handlers never call the host's tool, RPC or permission APIs.
- The conformance fixture is written by `test/conformance/record.test.ts`, then redacted with `npx plugin-kit record`.
- Run `npx plugin-kit docs` after changing the manifest, and commit the generated sections.
- Conventional commits. Do not add runtime dependencies, peer dependencies, lifecycle scripts or app names.
