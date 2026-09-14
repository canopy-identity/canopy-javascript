---
"@canopy-io/node": patch
"@canopy-io/nestjs": patch
---

Ship the changelog with the package, and create a GitHub Release per published
version.

The changelog was written on every release and reachable by nobody: `files`
omitted it, so npm showed none, and the release workflow pushed tags without
creating releases, so the Releases page sat empty. A consumer deciding whether
to take a bump had nothing to read. `CHANGELOG.md` is now in the tarball, each
README links it and notes that a pre-1.0 minor may break, and the workflow
opens a release whose body is that version's changelog section.
