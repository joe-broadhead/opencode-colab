# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-11-24

- Find local `.ipynb` files with `colab_find` and read notebook cells, outputs, kernel information and the file hash with `colab_notebook`.
- Create a notebook or edit its cells, metadata and outputs with the direct `colab_edit` tool. Editing an existing file requires its current `ifHash`.
- Code Mode and scripting expose the two read tools only. Writes require OpenCode file permissions and a verified local directory on a supported Linux filesystem.
- No Google requests, sign-in, notebook execution, cloud data access or source collection.
