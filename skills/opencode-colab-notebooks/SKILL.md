---
name: opencode-colab-notebooks
description: Notebook and Colab runtime facts for writing cells that run well on Colab - nbformat 4, /content, magics, GPU checks, memory, seeds and checkpoints - with ten worked examples.
---

# Notebooks on Colab

## nbformat 4

- A notebook is a JSON file: `cells` (each `code`, `markdown` or `raw`, with a `source`), notebook `metadata` (the
  kernel spec) and `nbformat` 4. Code cells also hold `outputs` and an `execution_count`.
- Cells have an `id` from nbformat 4.5. `colab_notebook` shows ids for older files too, derived from each cell's
  position and source; they are written into the file only when `colab_edit` writes it.
- Every edit names the `ifHash` that `colab_notebook` returned. `NOTEBOOK_CHANGED` means the file moved since: read it
  again.
- Running a notebook writes outputs back by cell id when the run ends, unless a run cell changed in the meantime; the
  outputs then stay in `.colab/runs/<runId>/`.

## The runtime

- The working folder is `/content`. Files there are lost when the runtime is released; write what matters to
  `/content/outputs`, which is downloaded (harvested) before a release.
- Colab runtimes come with common data and ML libraries installed. Check with `!pip list` rather than assume a version,
  and install what is missing with `%pip install -q pkg` (it installs into the kernel's own environment).
- `!cmd` runs one shell command; `%%bash` runs a whole cell in bash.
- Check a GPU before relying on it: `!nvidia-smi`, or `torch.cuda.is_available()`.
- Memory is the spec's: a high-memory shape (`SHAPE_HIGHMEM`) where `colab_specs` says it is eligible. A kernel that
  dies mid-run (`KERNEL_DIED`) usually ran out of memory: load less, in chunks, or plan a high-memory runtime.
- Variables live only in the kernel: a kernel restart or a release loses them all.
- `drive.mount`, `google.colab.auth` and `userdata` are refused here. Upload inputs with `colab_upload` and pass values in
  code.
- Set seeds (`random`, `numpy`, `torch`) for repeatable runs, and checkpoint long work to `/content/outputs` so a lost
  runtime loses little.

## Ten worked examples

Each block is the sequence of calls; `<…>` stands for the value the previous step returned.

1. **A CSV, pandas, a chart.** Upload the data, summarise it, save the table and the plot, bring both back.

```colab
colab_upload({ "runtime": "<runtime>", "path": "data/sales.csv", "to": "/content/sales.csv" })
colab_run({ "runtime": "<runtime>", "code": "import pandas as pd\ndf = pd.read_csv('/content/sales.csv')\nimport os; os.makedirs('/content/outputs', exist_ok=True)\ndf.groupby('region')['revenue'].sum().to_csv('/content/outputs/by_region.csv')" })
colab_download({ "runtime": "<runtime>", "path": "/content/outputs/by_region.csv" })
```

Then hand the path `colab_download` returns to the charts plugin, which reads CSV, TSV, JSON, JSONL and Parquet files
by path.

2. **A plot you can look at.** Every rich output is saved as a file; open the PNG by its path with `read`.

```colab
colab_run({ "runtime": "<runtime>", "code": "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3], [2, 4, 3])\nplt.title('trend')\nplt.show()" })
colab_execution({ "runId": "<runId>" })
```

3. **Run a notebook's cells in order, stop at the first error, write outputs back.**

```colab
colab_notebook({ "notebook": { "path": "analysis.ipynb" }, "outputs": "none" })
colab_run({ "runtime": "<runtime>", "notebook": { "path": "analysis.ipynb" }, "cells": "all", "wait": 300 })
```

4. **Only some cells.** By id, by index, or a range.

```colab
colab_run({ "runtime": "<runtime>", "notebook": { "path": "analysis.ipynb" }, "cells": { "from": 2, "to": 5 } })
colab_run({ "runtime": "<runtime>", "notebook": { "path": "analysis.ipynb" }, "cells": [0, 3] })
```

5. **Fix a failing cell.** Read the error, replace the cell's source with the hash you read, run that cell again.

```colab
colab_notebook({ "notebook": { "path": "analysis.ipynb" }, "cells": [4], "outputs": "full" })
colab_edit({ "path": "analysis.ipynb", "ifHash": "<hash>", "ops": [{ "op": "replace", "cell": 4, "source": "df = df.dropna(subset=['revenue'])" }] })
colab_run({ "runtime": "<runtime>", "notebook": { "path": "analysis.ipynb" }, "cells": [4] })
```

6. **A T4 fine-tune with checkpoints.** A GPU runtime, the check, then training that saves a checkpoint each epoch, so
   a lost runtime or a timeout loses at most one epoch. A long run comes back `running`; follow it.

```colab
colab_plan({ "action": "runtime.create", "params": { "spec": { "variant": "VARIANT_GPU", "shape": "SHAPE_STANDARD", "accelerator": "T4" } } })
colab_write({ "planId": "<planId>" })
colab_run({ "runtime": "<runtime>", "code": "!nvidia-smi\nimport torch; print(torch.cuda.is_available())" })
colab_run({ "runtime": "<runtime>", "notebook": { "path": "finetune.ipynb" }, "cells": "all", "wait": 60, "timeoutSec": 7200 })
colab_execution({ "runId": "<runId>", "wait": 600 })
colab_files({ "runtime": "<runtime>", "path": "/content/outputs/checkpoints" })
colab_download({ "runtime": "<runtime>", "path": "/content/outputs/checkpoints/last.pt" })
```

7. **A scratch session beside the notebook's.** Code in another `session` runs in its own kernel, so it does not wait
   for or disturb the notebook's.

```colab
colab_run({ "runtime": "<runtime>", "code": "import psutil; print(psutil.virtual_memory())", "session": "scratch" })
```

8. **An Enterprise job from a local notebook.** The whole notebook runs on its own compute with the account's service
   account; the output notebook comes back as files.

```colab
colab_plan({ "account": "work", "action": "job.create", "params": { "notebook": { "path": "report.ipynb" }, "machine": "e2-standard-4", "timeoutMinutes": 45 } })
colab_write({ "planId": "<planId>" })
colab_execution({ "account": "work", "job": "<job>", "wait": 120 })
```

9. **A bounded weekly schedule for that notebook.** It ends after 12 runs; the preview shows the next five run times
   and the worst case per run and per month.

```colab
colab_plan({ "account": "work", "action": "schedule.create", "params": { "notebook": { "path": "report.ipynb" }, "displayName": "weekly report", "cron": "0 7 * * 1", "timeZone": "Europe/London", "maxRunCount": 12, "timeoutMinutes": 45 } })
colab_write({ "planId": "<planId>" })
```

10. **Done: keep the results, release the runtime.** The release downloads `/content/outputs/**` first.

```colab
colab_files({ "runtime": "<runtime>", "path": "/content" })
colab_plan({ "action": "runtime.delete", "params": { "runtime": "<runtime>" } })
colab_delete({ "planId": "<planId>" })
```
