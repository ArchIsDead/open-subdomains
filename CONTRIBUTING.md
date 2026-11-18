# Contributing

One claim is one file. Check the name, copy the template, open the pull request.

## Claim a subdomain

1. Check the name at [is-a.ceo/check](https://is-a.ceo/check). It reads the same policy as the validator, so a name it refuses is refused by CI too.
2. Fork this repository and create a branch.
3. Copy `registry/example.json` to `domains/<your-name>.is-a.ceo.json`. A claim for `jane` becomes `domains/jane.is-a.ceo.json`.
4. Fill in `owner`, then run `npm run verify`.
5. Open the pull request against `main`, from the account named in `owner`, and fill in the template.

## An example pull request

Title: `Claim jane.is-a.ceo`

Changed files: `domains/jane.is-a.ceo.json`, added.

```json title="domains/jane.is-a.ceo.json"
{
  "$schema": "../registry/schema.json",
  "owner": {
    "username": "jane",
    "email": "jane@example.net"
  },
  "repo": "github.com/jane/jane.github.io",
  "description": "Portfolio"
}
```

Body: tick the five boxes, then fill in the two marked sections.

```text
Website preview: https://jane.github.io
Purpose: Portfolio
```

That is the whole change. A claim that also needs `records`, or a second file for a hosting proof, adds those files and stays one pull request.

## What to put in the file

`owner` is the only required key, and it needs a `username` or an `email`. Include `username`, because CI compares it with the account that opens the pull request and refuses a name claimed on someone else's behalf. `id` is optional: it is the number at `https://api.github.com/users/<username>`, and it survives a rename that would release your handle.

Leaving `records` out points the name at GitHub Pages, which is what a portfolio or project page needs. Any other host takes a `records` block. Every key, its limits, and the shape of each record type are in [Entry fields](https://docs.is-a.ceo/fields/) and [Records](https://docs.is-a.ceo/records/).

## What the pull request has to look like

A claim touches `domains/`. It may also fix a typo in the documentation, but it may not restructure the documentation in the same pull request.

`dnsconfig.js`, `scripts/`, `test/`, `package.json`, `.github/` and everything in `registry/` are trusted-author territory. Those files decide what everyone else may claim, so a change to them is reviewed on its own.

Editing the records in your own entry is fine. Deleting one is not, even when the entry is yours, because a delete and a claim are not the same review.

## What is refused, and what is only a note

The validator refuses a reserved or blocked name, a wildcard whose base you do not already hold, and a loopback, link-local or multicast address. The pull request body check refuses an unticked box, which is how the commercial and finished-site rules are enforced: nobody inspects your site, you attest to it.

Noted, and merged anyway: an email with no `username`, a private or documentation address, a name that reads like a reserved one, an uppercase filename, a repeated record value, a TXT value over 255 characters, and more than four entries in one pull request.

A note never blocks the merge, so a pull request carrying only notes passes. The reason behind each rule is in [Name policy](https://docs.is-a.ceo/policy/) and [Troubleshooting](https://docs.is-a.ceo/troubleshooting/).

## When a check fails

`npm run verify` prints the message CI would print, prefixed with the file that caused it. [Troubleshooting](https://docs.is-a.ceo/troubleshooting/) has a fix for each one, and [Validation rules](https://docs.is-a.ceo/validation/) explains the rule behind it. The bot comments the same verdict on your pull request, so a local clone is not required to read it.

A maintainer can loosen an individual check with a label. You never need to ask for one: if a check fails, fix the entry.

## Redirects

The zone is DNS only. There is no redirect record and no way to rewrite a path, so host the redirect yourself, either with an HTML meta refresh behind a `CNAME` or with the redirect feature your host offers.

## Abuse

Email [contact@hisoka.net](mailto:contact@hisoka.net) with the subject `abuse: <hostname>`, the full hostname, and what you saw. The policy is at [is-a.ceo/abuse](https://is-a.ceo/abuse).
