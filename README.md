# Accumout

Billing for wallets, apps and agents, settled on Solana.

[![Live site](https://img.shields.io/badge/live%20site-accumout.fun-0356f0)](https://accumout.fun)

| | |
|---|---|
| Chain | Solana |
| Contract address | _to be announced_ |

## Overview

Accumout is billing infrastructure for products that charge from a connected wallet. A plan can renew, usage can be metered and an agent can be given a spending budget, with settlement on Solana and no custody step in the middle.

## Features

- Signed authorization that opens access the moment a request is verified
- Plans that renew from a wallet
- Spending ceilings for autonomous agents
- Access rules that follow payment state
- Shareable pay links for amounts, invoices and add-ons
- A live Solana market board on the site, sourced from public DexScreener data

## Links

- Site: https://accumout.fun
- X: _to be announced_
- GitHub: _to be announced_
- Whitepaper: [docs/whitepaper.md](docs/whitepaper.md)

## Develop

```bash
npm install
npm run build    # writes the static site to dist/
npm run gates    # release checks, exit code 0 means ship
```

Deploy by uploading the contents of `dist/`.

## License

MIT, see [LICENSE](LICENSE).
