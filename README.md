# Juno Voice

**The on-chain roadmap for Juno.**

Juno Voice is a public feature-prioritization system where people and agents submit requests, Juno stakers signal priorities using historical voting power, and builders attach verifiable delivery evidence.

> `suggest → prioritize → build → verify → ship`

## Status

Architecture and product design. No contract is deployed and no funds are accepted.

- [Architecture](docs/architecture/ARCHITECTURE.md)
- [Product and interaction design](docs/design/PRODUCT_DESIGN.md)
- [Decision records](docs/architecture/decisions/)
- [Implementation plan](docs/plans/2026-07-23-mvp.md)
- [Interactive design prototype](prototype/index.html)

## Product principles

1. **Public demand, visible delivery.** Priorities and build evidence share one durable record.
2. **Power is frozen per request.** Votes use a declared historical Juno snapshot, not mutable current balances.
3. **Agents are participants, not hidden administrators.** Automation uses the same public interfaces and leaves evidence.
4. **Signal is not binding governance.** Juno Voice ranks work; it does not spend treasury funds or execute chain governance.
5. **Small credible loop first.** The MVP supports requests, stake-weighted support, lifecycle changes, and delivery evidence.

## Design system

Every UI must follow the [Juno Design System](https://github.com/juno-ai-dev/juno-design-system), pinned during this design pass at commit `0dc0ae9`.

The prototype uses its official mark/wordmark and exact coral, maroon, cream, type, spacing, radius, border, grid, and motion language. Product-specific patterns should be proposed upstream when they are reusable rather than silently forked.

## Repository shape

```text
docs/
  architecture/       system design and ADRs
  design/             UX, flows, screens, accessibility
  plans/              executable implementation plans
prototype/             dependency-free interaction prototype
```

Implementation will add a Rust/CosmWasm workspace and a production web app only after the architecture decisions are reviewed.

## License

MIT. See [LICENSE](LICENSE).
