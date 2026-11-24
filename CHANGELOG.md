# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.0 (unreleased)

- The plugin is `@we-the-rebel-alliance/colab-plugin`, on OpenCode `>=2.4.1 <2.5.0` (tested on 2.4.1), with the
  `colab` and `colab-notebooks` skills.
- Find local `.ipynb` files with `colab_find`; read cells, outputs, kernel information and the file hash with
  `colab_notebook`; create a notebook or edit its cells, metadata and outputs with the direct `colab_edit` tool.
  Editing an existing file requires its current `ifHash`.
- Code Mode and scripting expose the two read tools only. Writes require OpenCode file permissions and a verified local
  directory on a supported Linux filesystem.
- No Google requests, sign-in, notebook execution, cloud data access or source collection.
