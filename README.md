# trml-strava-stats

**Status: functional, OAuth verified against live Strava data, pushed to TRMNL** (plugin id `444560`).

A [TRMNL](https://usetrmnl.com) private plugin that shows your most recent ride and a Monday–Sunday weekly cycling summary, pulled from [Strava](https://www.strava.com). Rides only — no runs, swims, or other activity types. Sibling to the [`vuelta-a-espana-classification`](../vuelta-a-espana-classification) and [`vuelta-a-espana-stages`](../vuelta-a-espana-stages) plugins.

## How it works

TRMNL polls `GET https://www.strava.com/api/v3/athlete/activities?per_page=30` with `Authorization: Bearer {{ oauth_access_token }}` (OAuth2, standard Strava endpoints — `/oauth/authorize` + `/oauth/token`, scopes `read,activity:read_all`). `src/transform.js` then shrinks that raw response down to just the most recent ride and the current Mon–Sun weekly totals, since a full activities page can exceed TRMNL's 100kb direct-merge cap on its own — see [Parsing plugins with the sandbox runtime](https://help.trmnl.com/en/articles/12996946-parsing-plugins-with-the-sandbox-runtime). The four Liquid templates in `src/` render that shaped data. No separate backend required.

The "current week" is Monday–Sunday in the athlete's own timezone, inferred from the most recent ride's Strava `timezone` field (no extra `/athlete` profile fetch needed).

### OAuth setup notes

Strava's OAuth requires **comma-separated** scopes (`read,activity:read_all`), not the space-separated default most providers use — set via TRMNL's OAuth config's "Scope Separator" field. `approval_prompt=force` is set as a custom auth param so re-authorizing always re-prompts for consent rather than silently reusing a stale grant. Client ID/secret are entered directly in TRMNL's OAuth config UI and are never stored in this repo.

## Local preview

Requires Docker:

```sh
./bin/trmnlp serve
```

Then open `http://localhost:4567`. `.trmnlp.yml` ships with mock ride/weekly data (shaped like `transform.js`'s actual return value) so the preview works without a live OAuth connection.

## Deploying to TRMNL

Pushed once manually — plugin id `444560` ([dashboard](https://trmnl.com/plugin_settings/444560/edit)). CI (`.github/workflows/trmnl.yml`) re-pushes on every merge to `main`, gated behind `trmnlp lint`; it needs a `TRMNL_API_KEY` repo secret to do that. Not yet added to a device playlist.

## Disclaimer

Not affiliated with, endorsed by, or sponsored by Strava.
