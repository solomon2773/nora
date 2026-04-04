# Nora Runtime Direction

Nora should be positioned as an **open-source AI agent orchestration control panel**.

That positioning should stay consistent across the repo, screenshots, docs, install flow, and public site:

- **security built in**
- **easy to use**
- **expandable**
- **self-hostable**
- **enterprise-capable**

The practical meaning of that positioning is important.

Nora should feel credible for a single-machine self-hosted evaluation, but it should also feel architecturally serious enough to expand into **Proxmox**, **private cloud / on-prem**, and major cloud environments like **AWS**, **Azure**, and **GCP**.

## What Nora is today

Today, Nora is best understood as the operator surface around agent runtime deployment and ongoing operations.

That operator surface includes workflows like:

- runtime deployment
- provider credential management
- chat access
- logs and validation
- terminal workflows
- settings and operator controls

This is why "control panel" or "control plane" is the right frame. Nora is not just a landing page and it should not be described like a vague AI workforce shell.

## Runtime support today

**OpenClaw is the strongest supported runtime in Nora today.**

That should be stated clearly and repeatedly when someone asks for the fastest proof path.

A good short answer is:

> If you want the fastest proof of value today, start with Nora + OpenClaw.

That keeps the current product story honest and gives operators a concrete starting point.

## Future-runtime-friendly direction

Nora should not be framed as permanently useful only with OpenClaw.

The stronger long-term position is:

- OpenClaw is the best-supported runtime **today**
- Nora should remain friendly to additional runtime adapters over time
- docs and UI language should stay generic where the product surface is genuinely generic
- future-runtime direction should be described as direction, not as already-finished capability

## Product-language rules

Prefer language like:

- runtime
- runtime adapter
- orchestration control panel
- control plane
- operator workflow
- deployment footprint
- validation surface

Avoid language that implies:

- Nora is forever tied to a single runtime
- every future runtime integration already exists
- enterprise credibility comes from sales packaging instead of product proof

## Enterprise-capable, defined carefully

"Enterprise-capable" should mean:

- self-hosted teams can keep infrastructure ownership
- operators can scale from one machine to more segmented environments
- deployment footprints can extend into Proxmox, private cloud / on-prem, and AWS/Azure/GCP
- Nora can support serious operational workflows without abandoning the OSS trust model

It should **not** mean claiming that every enterprise integration, compliance control, or multi-runtime adapter is already complete.

## Positioning shorthand

Use this shorthand when concise copy is needed:

> Nora is an open-source AI agent orchestration control panel with security built in, designed to be easy to use, expandable, self-hostable, and enterprise-capable from single-host installs through Proxmox, private cloud, and AWS/Azure/GCP. OpenClaw is the strongest supported runtime today, while Nora stays future-runtime-friendly over time.

## Related docs

- [README](../README.md)
- [Deployment footprints](DEPLOYMENT_FOOTPRINTS.md)
- [Open-source usage guide](OPEN_SOURCE_USAGE.md)
- [Implementation proof](IMPLEMENTATION_PROOF.md)
- [Adoption checklist](ADOPTION_CHECKLIST.md)
