# What Colab costs

Facts as of 17 November 2026; package F keeps this page.

- **Colab** spends the person's compute units. Per-accelerator unit rates are not published and vary over time, and no
  documented API reports a balance or a burn rate, so the plugin counts runtime-hours and accelerators instead.
- **Colab Enterprise** bills the Cloud project: a machine's price plus a management fee, per vCPU-hour, GiB-hour,
  accelerator-hour and disk GiB-hour. A stopped runtime still bills its disk. Jobs carry a USD estimate and a compute
  cost cap ($5 by default, at most $50), and a one-hour `executionTimeout`.
