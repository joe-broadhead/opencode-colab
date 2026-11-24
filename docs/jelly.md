# Colab in Jelly

3 tools are declared (2 read-only).

| Tool | What it does |
| --- | --- |
| `colab.find` | Find local workspace notebooks. |
| `colab.notebook` | Read local notebook cells, outputs and hash. |
| `colab.edit` | Edit a local notebook after OpenCode file permissions. |

The two bundled skills are `opencode-colab` and `opencode-colab-notebooks`. Access is **Allowed** by default; **Ask before changes** asks before edits and **Read only** denies edits by default. The host's later rules still apply.

No compute, sign-in, sources or source conformance report: this plugin edits local notebooks without Google requests.

## Jelly's general access rules

The shared rules below describe how Jelly handles declarations across plugins. Colab does not declare sign-ins,
wildcard tools or `asks` entries.

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
