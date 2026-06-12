# Security

Report vulnerabilities privately via GitHub security advisories on this repository
(Security → Report a vulnerability). Do not open public issues for security reports.

The CLI stores API keys at `~/.config/caesar/config.json` with mode 0600 and never
logs or echoes keys.
