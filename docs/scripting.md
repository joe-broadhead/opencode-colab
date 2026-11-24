# Scripting and Code Mode

Only the read tools `find` and `notebook` are exposed through `google-colab.tools`. Code Mode likewise exposes `colab_find` and `colab_notebook`, not `colab_edit`. This package declares no sources or probe.
The read RPC uses the source-contract tools transport, pinned to tag v0.3.0.

Call `POST /api/rpc/google-colab.tools/describe` with `{"input":{}}` to see the exact schemas. For a read, send the call to the same location as an existing session with a selected agent, using `x-opencode-directory` or `location[directory]`:

```json
{"input":{"sessionID":"<session>","input":{"notebook":{"path":"example.ipynb"},"outputs":"none"}}}
```

Use that body with `POST /api/rpc/google-colab.tools/notebook`. Use `POST /api/rpc/google-colab.tools/find` with a local glob or `{}` as the inner input. The transport does not prompt: the relevant agent and session rules must already allow the method and any host file permissions. Account and cloud notebook references are not accepted. Returned content is untrusted data.

For the local status use `POST /api/rpc/google-colab/status` with `{"input":{}}`. Edits are only available via the direct tool, with OpenCode permissions.
