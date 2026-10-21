# Brand assets

| File | Use |
| --- | --- |
| `frontend/public/brand/mark.svg` | dark-background mark (copy also at `mark-light.svg`) |
| `frontend/public/brand/favicon.svg` | browser icon (16/32/48 PNG + ICO alongside) |
| `frontend/public/brand/app-icon-192.png`, `app-icon-512.png` | web manifest / PWA |
| `frontend/public/brand/app-icon-180.png` | Apple touch icon |
| `docs/brand/github-avatar.png` | GitHub organization/user avatar (500 px, circle-safe) |
| `docs/brand/social-preview.png` | GitHub social preview (1280×640) |

Regenerate every raster asset with:

```bash
.venv/Scripts/python.exe tools/make_brand.py
```

## GitHub repository settings

- **Social preview:** Settings → General → Social preview → upload
  `docs/brand/social-preview.png`.
- **Description:** “An AI social simulation lab: simulate how a population argues about a
  document. Every argument links to its source. Runs locally.”
- **Topics:** `agent-based-simulation`, `llm-agents`, `social-simulation`,
  `computational-social-science`, `policy-analysis`, `rag`, `fastapi`, `react`.
- Use `docs/brand/github-avatar.png` for the account/org avatar.

The mark: a paper-tone source square, six unconnected people, and a broken world ring.
Do not connect the dots, add glow/gradients, or use stance colours in the mark.
