# Working in this checkout

Written 2026-11-01, after four sessions sharing the AfyaMesh checkout
destroyed about forty minutes of uncommitted work and no command could be
found that did it. The same arrangement exists here, with more worktrees
and a far more dangerous database, so the same rules apply. AfyaMesh's own
copy is `D:\Apps\afyamesh\CLAUDE.md`; this one differs where this repo
does.

## There is more than one editor in this tree

`D:\Apps\chai-rfpis` is one working tree with one HEAD and one index, and
several Claude sessions have it open at once. You cannot see another
session's uncommitted work, and `git status` will not say whose it is.

It is dirty right now, and none of it is yours unless you put it there:
`README.md` is modified, and `donor_intel/`, `docs/Canonical Reference`,
a purged-rows CSV under `data/` and a log dump are untracked. Treat every
one of them as somebody's live work.

## Build in your own worktree, land in this one

    git worktree add .claude/worktrees/<task> -b <task> origin/main

The final argument is not optional, and it matters more here than
anywhere. **Local `main` is 69 commits ahead of `origin/main`.** Omit
`origin/main` and your branch starts from `HEAD`, which carries all 69 -
so the PR you open exports sixty-nine commits of other people's unreviewed
work under your title. There are six worktrees already; this is a busy
tree.

`.claude/worktrees/` is excluded, but via `.git/info/exclude` rather than
`.gitignore`, so the protection is local to this clone and does not travel.

## Commit before you think you need to

Uncommitted work in a shared tree exists in exactly one place. Anything
that writes the tree takes it with no reflog entry, no dangling object and
nothing to recover from - which is precisely how AfyaMesh lost forty
minutes to a command nobody could name afterwards. Commit within minutes
of starting to edit, not at the end of the task. A commit on your own
branch can be amended, reworded or squashed later.

## Never run a tree-wide git command here

    git reset --hard        git checkout -- .
    git restore .           git clean -fd
    git stash

They take files you never touched. `git clean -fd` here would delete
`donor_intel/` and the other untracked work listed above. `git stash` does
not destroy another session's edits, it hides them where that session will
never think to look. The GUI spellings count - a VCS panel's Rollback,
Revert or Discard acting on a changelist rather than a file is the same
command with a dialog that does not say whose work is in the list.

A scoped revert is not automatically safe either: `git checkout -- <path>`
destroys whatever another session has in that file right now.

## The database is real, hosted and shared

This is the sharpest difference from the other projects. There is no local
throwaway Postgres: `db/supabase_client.py` talks to a hosted Supabase
instance holding real CHAI data, and every session and every environment
reaches the same one. A migration applied here is applied for everybody,
immediately, including whatever the user has open.

Migrations are hand-numbered SQL in `db/migrations` - 98 files, highest
`101_live_scores.sql`. Two consequences:

  * **The next free number is not `last + 1`.** The sequence already has
    holes: 096 and 097 do not exist. Two sessions can easily reach for the
    same number, and nothing stops them. Check the directory, and check
    `reconcile_migration_ledger.py` and `verify_migrations.py` before you
    assume your number is yours.
  * **Commit the file before you apply it.** Otherwise the shared database
    carries a change that exists in no branch and no file, and the cause
    is invisible from the repository because the evidence is in the
    database rather than in git. That cost the Opportunova sessions a day
    this week, on a database that was only a dev one.

If something fails in a way the tree cannot explain, ask what the database
is actually at before hunting through branches.

## Say which files you own, before you touch them

Message the other sessions with the paths you are about to edit, and read
what they claim.

Finding them takes one call, and it is not `ListAgents` - that gives live
titles and nothing else. `list_sessions` without `linked: true` is the
roster: sessions outside your own family edit this tree and never appear
in your notifications. Match on `group`, which for this project is
`cg-755b69db`, because it is the one field that works for every session.
`cwd` only helps for a session running inside a worktree, which carries
its real path - one started from the app's root reports a bare `D:\Apps`
whichever project it is actually on. A title that sounds like your area is
a guess, not a finding.

## Do not push `main`

`main` here is the shared finish line, so by design it is never only your
work - and with 69 unpushed commits on it, "never only yours" is an
understatement. Branch from `origin/main`, cherry-pick your own commits
onto it, and push nothing until the user has reviewed it here and said so.

## If work is lost, stop and look before rebuilding

Check in this order, and read the absences as evidence:

  * `git reflog` - `git reset --hard` always writes an entry, so a gap
    there rules it out rather than leaving it open.
  * `git fsck --unreachable --dangling` and `git stash list`, with dates.
  * `D:\$RECYCLE.BIN`, volume shadow copies, and the IDE's local history.

If those are empty, the session transcripts are the only copy, and they
are a good one. Replay from the transcript rather than reconstructing from
memory, and resist blaming the most recent git operation - the merge
everyone blamed in AfyaMesh turned out to have identical trees on both
sides and to have written no file at all.
