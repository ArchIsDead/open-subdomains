# Instructions for AI agents

This file is for AI coding agents working in `HisokaLabs/open-subdomains` on behalf of a human user.

## Project policy

AI assistance is allowed here. What the maintainers do not accept is a submission nobody read.

A pull request that fails because the agent guessed a field, invented an IP address, or never ran the checks wastes a reviewer's time. It would have been caught by one local run.

## What you must do

1. Read [docs.is-a.ceo](https://docs.is-a.ceo) before writing an entry. The fields here are not the same as another subdomain registry, and the differences are exactly what fails the check.
2. Run `npm run verify` before suggesting a pull request. It runs the validator and the test suite in the order CI does. If it fails, fix the entry and run it again. Never tell the user to open a pull request whose check you know fails.
3. Say the pull request is AI-assisted. One line is enough: `Written with AI assistance; npm run verify passes locally.` The user still opens the pull request themselves, because the claim has to come from the account named in `owner`.
4. Stay in `domains/`. The entry is one file. Do not touch `registry/`, `scripts/`, `test/`, `dnsconfig.js` or `.github/`. Those are trusted-author territory, and a pull request that mixes them with a claim is refused.
5. Do not guess. A hostname you invented, an IPv4 address you half-remember, or an email the user never gave you will fail the validator or resolve to nothing. Ask for the value.
6. Check the use before you help. These names are personal and non-commercial. If the user describes a shop, a business site, or something to park and sell, say so and stop: the pull request will be refused on the rule rather than on the JSON. The site behind the name also has to be reachable and finished.

## What you must not do

Do not invent the numeric id in `owner`. Read it from `https://api.github.com/users/<username>`, or leave `id` out entirely. Nothing breaks without it, because `username` is what ties the claim to the account opening the pull request.

An email is not a substitute for a username. An entry with only an `email` passes the check and then waits on a maintainer to confirm it by hand, so include `username` when the user is filing their own claim.

## State of knowledge you can rely on

- `npm run verify` locally reaches the same verdict as CI, with two exceptions: the claimant check answers "did the account that opened this pull request write this entry", which needs `PR_AUTHOR` and `PR_AUTHOR_ID`, and the pull request body check needs `PR_BODY`. Local runs without them skip those two rules; CI always sets both.
- Four tests skip on Windows because a filename cannot contain `*` and cannot differ from an existing one only by case. They run on Linux, where CI runs. A local run showing `pass 106, skipped 4` is a full pass.
- The scripts are the authority. Where this file, the README and the documentation disagree about a rule, run the script and trust its exit code.

## Do not ask for a bypass label

The labels `maintainer`, `ci: bypass-scope`, `ci: bypass-owner-check` and `ci: bypass-template-check` exist so a maintainer can take a decision the rules cannot see. They are not a way around a failing check.

If a check fails, fix the entry. If you believe the check is wrong, say why in the pull request and let a maintainer decide. An agent that asks for a label to get past a refusal has misunderstood what the label is for.

## What is a note rather than a refusal

The registry is deliberately loose about anything that still produces a working record. These come back as notes, and a pull request that carries only notes exits 0:

- An owner with an email and no `username`.
- A private or documentation IP address.
- A name that reads like a reserved word without being one.
- An uppercase filename.
- A repeated record value, which the push drops.
- A TXT value over 255 characters.
- More than four entries in one pull request.

If the user sees one of these and wants it gone, fix the entry. Do not tell them the check failed, because it did not.

## Where the answers are

| Question | Page |
| --- | --- |
| How does a claim work end to end? | [Claim a subdomain](https://docs.is-a.ceo/claim/) |
| Which fields exist? | [Entry fields](https://docs.is-a.ceo/fields/) |
| What does an `MX` or `SRV` record look like? | [Records](https://docs.is-a.ceo/records/) |
| Why was this name refused? | [Name policy](https://docs.is-a.ceo/policy/), [Validation rules](https://docs.is-a.ceo/validation/) |
| The check printed a message. What is the fix? | [Troubleshooting](https://docs.is-a.ceo/troubleshooting/) |
| The user wants the record deleted | [Name policy](https://docs.is-a.ceo/policy/). Releasing a name is a trusted author's action. |

## When the user only wants to know whether a name is free

Send them to [is-a.ceo/check](https://is-a.ceo/check). It applies the same reserved and blocked lists, so a name it refuses is refused by CI too.
