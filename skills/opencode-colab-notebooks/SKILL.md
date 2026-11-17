---
name: opencode-colab-notebooks
description: Notebook and Colab runtime facts for writing cells that run well on Colab - nbformat 4, /content, magics, GPU checks, memory, seeds and checkpoints.
---

# Notebooks on Colab

- A notebook is an nbformat 4 file. Cells have an `id` (nbformat 4.5); `colab_notebook` shows derived ids for older
  files without writing them.
- The runtime's working folder is `/content`. Files there are lost when the runtime is released; save what matters to
  `/content/outputs`, which is harvested before release.
- `!cmd` runs a shell command; `%pip install -q pkg` installs into the kernel's environment.
- Check a GPU with `!nvidia-smi` or `torch.cuda.is_available()` before relying on it.
- Set seeds for repeatable runs, and checkpoint long training to `/content/outputs` so a lost runtime loses little.
