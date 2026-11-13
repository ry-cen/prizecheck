# Dev deployment guide moved

The dev host guide moved to [deployment-dev.md](deployment-dev.md), covering Ubuntu and other systemd Linux hosts. Follow that guide for installation and migration.

The unchanged deployment script still names this file. Its legacy dev diagnostics may mention Unraid settings or Compose Manager: use the Linux instructions below instead. This compatibility map keeps every dev-path step and named section resolvable without changing the production host bundle digest.

| Script reference               | Section in deployment-dev.md                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| step 1 (Docker)                | [1. Prepare the Linux host](deployment-dev.md#1-prepare-the-linux-host)                                                   |
| step 2 (Compose)               | [2. Install Docker Compose](deployment-dev.md#2-install-docker-compose)                                                   |
| step 4 (Tailscale)             | [4. Enable Tailscale Serve](deployment-dev.md#4-enable-tailscale-serve)                                                   |
| Create the env file            | [6. Create the env file](deployment-dev.md#6-create-the-env-file)                                                         |
| Updating the host files        | [Updating the host files](deployment-dev.md#updating-the-host-files)                                                      |
| Perform the initial deployment | [11. Perform the initial deployment](deployment-dev.md#11-perform-the-initial-deployment)                                 |
| Apply the catalog rules        | [13. Apply the catalog rules and import the catalog](deployment-dev.md#13-apply-the-catalog-rules-and-import-the-catalog) |
| User Scripts / schedules       | [9. Install the host files and run setup](deployment-dev.md#9-install-the-host-files-and-run-setup)                       |

Unnumbered Docker, configuration and tailnet errors also refer to the new guide. Dev commands still run as root without a sudo prefix. On systemd hosts, `setup` installs timers; User Scripts output remains only for legacy hosts without systemd.
