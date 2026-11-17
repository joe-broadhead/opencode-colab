# Architecture

The plugin is one server bundle (`dist/index.js`) and one TUI bundle (`dist/tui.js`). The server part registers, in
order: the default permission rules, status (`/colab-status` and the status RPC), the tools RPC for scripts, and the
skills. The tools, their contract and the ports they build on arrive with the Day 0 contract.
