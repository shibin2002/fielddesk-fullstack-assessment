# Submission instructions

Submit the assessment through a pull request from your own GitHub fork. Do not request direct write access and do not push to Gatlier's `main` branch.

## 1. Fork the repository

Open the assessment repository and select **Fork**:

```text
https://github.com/DT-Gatlier/fielddesk-fullstack-assessment
```

Create the fork under your own GitHub account.

## 2. Clone your fork

Replace `<your-github-username>` in the commands below:

```bash
git clone https://github.com/shibin2002/fielddesk-fullstack-assessment.git
cd fielddesk-fullstack-assessment
git remote add upstream https://github.com/DT-Gatlier/fielddesk-fullstack-assessment.git
git switch -c assessment/shibin2002
```

Confirm the remotes before starting:

```bash
git remote -v
```

`origin` should point to your fork and `upstream` should point to the Gatlier repository.

## 3. Commit your work

Use clear, logically separated commits. Commit messages should explain the completed change rather than use generic messages such as `update` or `final`.

Do not commit:

- `.env` files
- Passwords, API keys or access tokens
- Generated dependency directories
- Build output
- Personal or employer-confidential material

## 4. Complete the submission documents

Before submitting, complete:

- `candidate-submission/TECHNICAL_NOTES.md`
- `candidate-submission/AI_USAGE.md`

Do not delete unanswered sections. Use `Not applicable` where appropriate.

## 5. Push your branch

```bash
git push -u origin assessment/shibin2002
```

## 6. Open the pull request

Open a pull request from:

```text
<your-github-username>/fielddesk-fullstack-assessment:assessment/<your-github-username>
```

into:

```text
DT-Gatlier/fielddesk-fullstack-assessment:main
```

Complete every section of the pull-request template. Keep the pull request open until Gatlier confirms that the review is complete.

## 7. Screen recording

Include a link to a 10–15 minute screen recording demonstrating:

- The documented startup process
- Login using users from two different organisations
- Role restrictions
- Main frontend workflows
- Scheduling-conflict handling
- Attachment upload and access control
- Real-time updates
- Background-job success and failure behaviour
- Automated tests running

The recording should show the application running on your computer. Do not expose passwords, tokens or unrelated personal information.

## 8. Final confirmation

Include in the pull request:

- Final commit SHA
- Screen-recording link
- Exact test, lint and build commands
- Results of those commands
- Known limitations
- Completed AI usage disclosure

Questions, assumptions and blockers must be raised using GitHub Issues in the Gatlier assessment repository.
