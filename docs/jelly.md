# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this package's `package.json` as
JSON, without loading the plugin, when a person reviews the exact version, and uses it as follows.

Jelly names the plugin **Colab** (`jelly.title`), with the package name and version beneath, the one line in
`jelly.summary`, and the mark in `jelly.icon` (`assets/icon.svg`, shipped in the package). The mark is the family's own
tile, not Google's or Colab's logo.

## Tools and permissions

22 tools are declared (14 read-only): the twenty tools, `colab.status` to `colab.delete`, each with the permission
it asserts (`colab.<tool>`), and two permission-only reads with no tool of their own: `colab.read`, which every
provider read asserts, and `colab.probe`, which the source contract's probe asserts. Declared read-only, both run at
every access choice, so a read tool never asks or fails because of the reads it makes. `test/unit/jelly.test.ts` checks
that every action the plugin asserts is declared, and simulates Jelly's rules at each choice.

The family's shared rules, word for word from Jelly's guide:

<!-- family-block:start -->
- At Allowed (`all`), the default, every tool runs without asking, declared or not, whatever its `effect`.
- At Ask before changes (`ask-changes`), a `readOnly` tool runs, and every other tool asks first, including a tool this plugin does not declare.
- At Read only (`read-only`), a `readOnly` tool runs, and every other tool is off, including a tool this plugin does not declare.
- A declared `effect` of `allow` changes nothing: the tool follows the access choice and its `readOnly`.
- A declared `effect` of `ask` makes the tool ask at Ask before changes, even when it is `readOnly`, and changes nothing at Allowed or Read only.
- A declared `effect` of `deny` turns the tool off at Ask before changes and at Read only, and changes nothing at Allowed.
- An action listed in `asks` asks first at Ask before changes and at Read only, and never at Allowed.
- A tool named with one `*`, such as another account's `plaud-*.get_file`, follows the same rules as a tool named in full.
- A choice the person makes for one tool wins over the access choice and the declared `effect`.
- jelly leaves out a key it does not know at the top level of the `jelly` block, and reads the rest.
- jelly refuses the plugin for a key it does not know inside anything it reads, such as a tool, a sign-in or a setting.
- jelly refuses the plugin, with one plain line, when `requires` names a field or a feature it does not read.
<!-- family-block:end -->

`/colab-cleanup`'s action, `colab.cleanup`, is a command's, not a tool's, so it is not declared: Jelly's namespace rule
decides it. At Allowed it runs each action the person confirmed in the command without a second prompt; the person
typed the command, and its report lists every action first.

## Skills

Declared: `opencode-colab` and `opencode-colab-notebooks`.

## Cost

`jelly.cost`, shown on the review before the plugin installs: Colab spends the person's compute units (the free tier
without them); Colab Enterprise bills the Cloud project, about $0.20–$5 an hour; Enterprise jobs have a compute cost cap
and a one-hour limit; and at Allowed, idle runtimes the plugin started are released after 20 minutes, deleting their
files outside `/content/outputs`. `jelly.admin` names the two admin steps: allowing the OAuth client where an
organisation restricts Google sign-ins, and, for Colab Enterprise, the Colab Enterprise User and Service Account User
roles on a billed project.

## Signing in

`jelly.signIns` declares one Google sign-in, `google-colab`, for the integrations `colab-<alias>`. Its `scopes` are the
sorted union of every scope an account may request, consumer and Enterprise. It uses Jelly's `google` host client
(`hostClient`) in place of a client the person enters, and the relay for the redirect. `needed` names the codes that
ask the person to sign in: `AUTH_REQUIRED` and `AUTH_SCOPE_MISSING`.

## Settings

`jelly.contributes.settings` declares `access`, a choice of three: **Allowed** (`all`, the default), **Ask before
changes** (`ask-changes`) and **Read only** (`read-only`), with Jelly's own line for each.

## Sources

The `sources` key (beside `jelly`, read by Jelly and Memory with the source contract) declares `colab.runs` (events from
the plugin's own ledger) and `colab.runtimes` (a snapshot `list`), both free and private, read through the tools RPC
`google-colab.tools`, with `colab.probe` naming the signed-in owner. A grant for either asserts exactly what it
declares: the source's own action, then `colab.read` on the operation it reads — both declared read-only, so a grant
never asks. The declaration holds no key a v0.1.x consumer refuses (`test/unit/sources-declaration.test.ts`), and
`npm run conformance` runs the contract's kit over both sources and writes the report the release attaches.
[Scripting](scripting.md#sources) describes both.

## Versions

Jelly's curated catalogue pins an exact version. The declaration test runs the shared kit, `test/support/jelly-kit.ts`,
and Jelly's setting rules, `test/support/jelly-settings.ts`; `scripts/check-copies.mjs` keeps both equal to the copies
every plugin carries.
