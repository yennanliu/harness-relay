/*
 * An agent asks for a repository outside the conversation's working directories (`[ASK_FOLDER …]`):
 * the team waits, and once the user allows it the agents work in a copy of it (a git worktree on a new
 * branch), whose changes are committed to that branch when the run ends.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cwdsOf, type Conversation, type MessagePart } from '../src/shared/types';
import { Store, agentMessages, agents, calls, conversation, db, fake, finish, n, orchestrator, project, root, store, textOf } from './orchestrator-harness';

type FolderPart = Extract<MessagePart, { type: 'folder' }>;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** A repository outside the conversation's working directories, with one commit and an ignored file. */
function otherRepo(name = 'other'): string {
  const dir = join(root, `${name}-${n}`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'other repository\n');
  writeFileSync(join(dir, 'src', 'main.txt'), 'main\n');
  writeFileSync(join(dir, '.gitignore'), '.env\n');
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

const folderPart = (conv: Conversation): FolderPart | undefined =>
  conv.messages.flatMap((m) => m.parts).find((p): p is FolderPart => p.type === 'folder');
const asking = (conv: Conversation) => conv.messages.find((m) => m.parts.some((p) => p.type === 'folder'))!;
const systemNotes = (conv: Conversation) => conv.messages.filter((m) => m.author.kind === 'system').map(textOf);

describe('an agent asks for a folder', () => {
  it('waits for the user with a request that says what allowing changes, and takes the marker out of the reply', async () => {
    const other = otherRepo();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${other} edit]` };
    await orchestrator.send(conv.id, 'fix the other repository');
    await finish(conv.id);

    const [alice] = agentMessages(conv);
    expect(textOf(alice!)).toBe('Alice needs another repository.');
    expect(alice!.asked).toBe(true);
    expect(folderPart(conv)).toEqual({ type: 'folder', path: other, edit: true, status: 'pending' });
    // The team stopped for it: Bob has not spoken.
    expect(conv.pause?.askers).toEqual(['a']);
    expect(calls.map((c) => c.name)).toEqual(['Alice']);
    // Nothing changed yet.
    expect(conv.settings).toMatchObject({ permission: 'read-only', cwd: project });
    expect(conv.settings.copies).toBeUndefined();
    // Kept across a restart.
    store.flush(conv.id);
    expect(folderPart(new Store(db).get(conv.id)!)).toMatchObject({ path: other, edit: true, status: 'pending' });
  });

  it('allowed: makes a copy on a new branch, raises read-only to edit, and the agent goes on in the copy', async () => {
    const other = otherRepo();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${other} edit]` };
    await orchestrator.send(conv.id, 'fix the other repository');
    await finish(conv.id);
    calls.length = 0;

    await orchestrator.answerFolder(conv.id, asking(conv).id, { allow: true });
    await finish(conv.id);

    const [copy] = conv.settings.copies!;
    expect(copy).toMatchObject({ of: other, root: other, branch: `relay/${conv.id.slice(0, 8)}-copy/other-${n}` });
    expect(copy!.path.startsWith(join(root, 'data', 'worktrees', conv.id, 'copy-'))).toBe(true);
    expect(conv.settings).toMatchObject({ permission: 'edit', cwd: project, extraCwds: [copy!.path] });
    expect(folderPart(conv)).toMatchObject({ status: 'allowed', copy: copy!.path, branch: copy!.branch });
    // The copy is the repository at its last commit: nothing git ignores.
    expect(readFileSync(join(copy!.path, 'README.md'), 'utf8')).toBe('other repository\n');
    expect(existsSync(join(copy!.path, '.env'))).toBe(false);

    // The asking agent answers first, told where the copy is; then the rest of the team.
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    expect(calls[0]).toMatchObject({ cwd: project, addDirs: [copy!.path], permission: 'edit' });
    expect(calls[0]!.prompt).toContain(copy!.path);
    expect(calls[0]!.prompt).toContain('You asked the user a question');
    expect(calls[0]!.systemPrompt).toContain(`${copy!.path} is a copy of ${other} (branch ${copy!.branch} of the repository ${other})`);

    // What the agents wrote is in the copy and on its branch, not in the repository's own checkout.
    expect(existsSync(join(copy!.path, 'Alice.txt'))).toBe(true);
    expect(existsSync(join(other, 'Alice.txt'))).toBe(false);
    expect(git(other, 'status', '--porcelain')).toBe('');
    expect(git(other, 'rev-parse', '--abbrev-ref', 'HEAD')).not.toBe(copy!.branch);
    expect(git(other, 'show', '--stat', '--format=%s', copy!.branch)).toContain('Alice.txt');
    expect(git(other, 'show', `${copy!.branch}:Bob.txt`)).toBe('Bob was here');
    expect(git(other, 'log', '--format=%s', copy!.branch).split('\n')).toEqual(['Harness Relay: test', 'first']);
    expect(systemNotes(conv).some((t) => t.includes(copy!.branch))).toBe(true);
  });

  it('commits again after a later run, and only when something changed', async () => {
    const other = otherRepo();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${other} edit]` };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    await orchestrator.answerFolder(conv.id, asking(conv).id, { allow: true });
    await finish(conv.id);
    const [copy] = conv.settings.copies!;
    const commits = () => git(other, 'rev-list', '--count', copy!.branch);
    expect(commits()).toBe('2');

    // The fake writes the same files again: nothing new to commit.
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    expect(commits()).toBe('2');

    fake.during = (name) => writeFileSync(join(copy!.path, 'more.txt'), `${name}\n`);
    await orchestrator.send(conv.id, 'more');
    await finish(conv.id);
    expect(commits()).toBe('3');
  });

  it('denied: nothing changes and the agent is told, with the note', async () => {
    const other = otherRepo();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${other} edit]` };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    calls.length = 0;

    await orchestrator.answerFolder(conv.id, asking(conv).id, { allow: false, note: 'describe the change instead' });
    await finish(conv.id);

    expect(folderPart(conv)).toMatchObject({ status: 'denied', note: 'describe the change instead' });
    expect(conv.settings).toMatchObject({ permission: 'read-only', cwd: project });
    expect(conv.settings.copies).toBeUndefined();
    expect(existsSync(join(root, 'data', 'worktrees', conv.id))).toBe(false);
    expect(git(other, 'branch', '--list', 'relay/*')).toBe('');
    expect(calls[0]!.name).toBe('Alice');
    expect(calls[0]!.prompt).toContain(other);
    expect(calls[0]!.prompt).toContain('describe the change instead');
  });

  it('without "edit" keeps the permission, and a folder of a repository becomes that folder of the copy', async () => {
    const other = otherRepo();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${join(other, 'src')}]` };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(folderPart(conv)).toEqual({ type: 'folder', path: join(other, 'src'), status: 'pending' });

    await orchestrator.answerFolder(conv.id, asking(conv).id, { allow: true });
    await finish(conv.id);
    const [copy] = conv.settings.copies!;
    expect(conv.settings.permission).toBe('read-only');
    expect(copy).toMatchObject({ of: join(other, 'src'), root: other, path: join(copy!.tree, 'src') });
    expect(conv.settings.extraCwds).toEqual([join(copy!.tree, 'src')]);
    expect(readFileSync(join(copy!.path, 'main.txt'), 'utf8')).toBe('main\n');
  });

  it('a request for one of the working directories puts its copy in its place', async () => {
    git(project, 'init', '-q');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'first');
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${project} edit]` };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(folderPart(conv)).toMatchObject({ path: project, drops: [project] });
    calls.length = 0;

    // From here on the agents run in the copy: what they write is there only.
    fake.during = (name, cwd) => writeFileSync(join(cwd, 'after.txt'), `${name}\n`);
    await orchestrator.answerFolder(conv.id, asking(conv).id, { allow: true });
    await finish(conv.id);
    const [copy] = conv.settings.copies!;
    expect(conv.settings).toMatchObject({ permission: 'edit', cwd: copy!.path });
    expect(conv.settings.extraCwds).toBeUndefined();
    expect(calls.map((c) => c.cwd)).toEqual([copy!.path, copy!.path]);
    expect(existsSync(join(project, 'after.txt'))).toBe(false);
    expect(existsSync(join(copy!.path, 'after.txt'))).toBe(true);
    expect(git(project, 'show', `${copy!.branch}:after.txt`)).toBe('Bob');
  });

  it('refuses what it cannot copy, and changes nothing', async () => {
    const plain = join(root, `plain-${n}`);
    mkdirSync(plain, { recursive: true });
    const empty = join(root, `empty-${n}`);
    mkdirSync(empty, { recursive: true });
    git(empty, 'init', '-q');
    for (const [dir, status] of [
      [plain, 400],
      [empty, 400],
      [join(root, `missing-${n}`), 404],
    ] as const) {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      fake.folderAsk = { Alice: `[ASK_FOLDER ${dir} edit]` };
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      await expect(orchestrator.answerFolder(conv.id, asking(conv).id, { allow: true })).rejects.toMatchObject({ status });
      // Still waiting, as it was: the user can deny it, or answer in words.
      expect(folderPart(conv)).toMatchObject({ status: 'pending' });
      expect(conv.pause?.askers).toEqual(['a']);
      expect(conv.settings).toMatchObject({ permission: 'read-only', cwd: project });
      expect(conv.settings.copies).toBeUndefined();
      expect(existsSync(join(root, 'data', 'worktrees', conv.id))).toBe(false);
    }
    // No repository was made where there was none.
    expect(existsSync(join(plain, '.git'))).toBe(false);
  });

  it('refuses a copy that would take the working directories over the limit', async () => {
    const other = otherRepo();
    const extra = Array.from({ length: 7 }, (_, i) => {
      const dir = join(root, `extra-${n}-${i}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', extraCwds: extra });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${other}]` };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    await expect(orchestrator.answerFolder(conv.id, asking(conv).id, { allow: true })).rejects.toMatchObject({ status: 400 });
    expect(cwdsOf(conv.settings)).toEqual([project, ...extra]);
    expect(conv.settings.copies).toBeUndefined();
    expect(git(other, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('can be answered once, and not after the user replied in words', async () => {
    const other = otherRepo();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${other}]` };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'no need, just describe it');
    await finish(conv.id);
    await expect(orchestrator.answerFolder(conv.id, asking(conv).id, { allow: true })).rejects.toMatchObject({ status: 404 });
    expect(conv.settings.copies).toBeUndefined();

    const again = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${other}]` };
    await orchestrator.send(again.id, 'go');
    await finish(again.id);
    await orchestrator.answerFolder(again.id, asking(again).id, { allow: false });
    await finish(again.id);
    await expect(orchestrator.answerFolder(again.id, asking(again).id, { allow: true })).rejects.toMatchObject({ status: 404 });
    await expect(orchestrator.answerFolder(again.id, 'no-such-message', { allow: true })).rejects.toMatchObject({ status: 404 });
  });

  it('removes a copy with its conversation, or when it is no longer a working directory, and keeps its branch', async () => {
    const other = otherRepo();
    for (const how of ['delete', 'settings'] as const) {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      fake.folderAsk = { Alice: `[ASK_FOLDER ${other} edit]` };
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      await orchestrator.answerFolder(conv.id, asking(conv).id, { allow: true });
      await finish(conv.id);
      const [copy] = conv.settings.copies!;
      expect(git(other, 'worktree', 'list')).toContain(copy!.tree);

      if (how === 'delete') await orchestrator.deleteConversation(conv.id);
      else {
        const next = { ...conv.settings, cwd: project };
        delete next.extraCwds;
        await orchestrator.retainCopies(conv, next);
        expect(next.copies).toBeUndefined();
      }
      expect(existsSync(copy!.tree)).toBe(false);
      expect(git(other, 'worktree', 'list')).not.toContain(copy!.tree);
      expect(git(other, 'show', `${copy!.branch}:Alice.txt`)).toBe('Alice was here');
      // The snapshot refs the conversation kept in the repository go with it.
      if (how === 'delete') expect(git(other, 'for-each-ref', `refs/harness-relay/${conv.id}/`)).toBe('');
    }
  });

  it('keeps the copies that are still working directories when the settings change', async () => {
    const other = otherRepo();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${other} edit]` };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    await orchestrator.answerFolder(conv.id, asking(conv).id, { allow: true });
    await finish(conv.id);
    const [copy] = conv.settings.copies!;
    const next = { ...conv.settings, rounds: 2 };
    delete next.copies;
    await orchestrator.retainCopies(conv, next);
    expect(next.copies).toEqual([copy]);
    expect(existsSync(copy!.tree)).toBe(true);
  });

  it('in parallel mode keeps the copy\'s branch apart from the agents\' own, and commits what is applied to the copy', async () => {
    // A repository in a folder called as an agent is: their branches must not be one.
    const other = join(root, `named-${n}`, 'Alice');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'README.md'), 'other repository\n');
    git(other, 'init', '-q');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'first');
    const conv = conversation({ mode: 'parallel', permission: 'read-only' });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${other} edit]` };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    await orchestrator.answerFolder(conv.id, asking(conv).id, { allow: true });
    await finish(conv.id);
    const [copy] = conv.settings.copies!;
    expect(copy!.branch).toBe(`relay/${conv.id.slice(0, 8)}-copy/Alice`);
    // The run went through (no branch of the copy was taken or reset), each agent in a worktree of the copy.
    expect(agentMessages(conv).at(-1)!.status).toBe('done');
    const mine = conv.worktrees.a!.find((w) => w.root === copy!.tree)!;
    expect(mine.branch).toBe(`relay/${conv.id.slice(0, 8)}/Alice`);
    expect(git(other, 'log', '--format=%s', copy!.branch)).toBe('first');
    // Nothing reached the copy yet: the agents wrote in their own worktrees.
    expect(existsSync(join(copy!.path, 'Alice.txt'))).toBe(false);

    await orchestrator.applyAgentWork(conv.id, 'a');
    expect(existsSync(join(copy!.path, 'Alice.txt'))).toBe(true);
    expect(git(other, 'show', `${copy!.branch}:Alice.txt`)).toBe('Alice was here');
    expect(git(other, 'log', '--format=%s', copy!.branch).split('\n')).toEqual(['Harness Relay: test', 'first']);
    expect(existsSync(join(other, 'Alice.txt'))).toBe(false);
  });

  it('commits what is in a copy and not on its branch yet before removing it', async () => {
    const other = otherRepo();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.folderAsk = { Alice: `[ASK_FOLDER ${other} edit]` };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    await orchestrator.answerFolder(conv.id, asking(conv).id, { allow: true });
    await finish(conv.id);
    const [copy] = conv.settings.copies!;
    writeFileSync(join(copy!.path, 'late.txt'), 'late\n');
    await orchestrator.deleteConversation(conv.id);
    expect(existsSync(copy!.tree)).toBe(false);
    expect(git(other, 'show', `${copy!.branch}:late.txt`)).toBe('late');
  });

  it('shows the card of a reply that is nothing but the request', async () => {
    const other = otherRepo();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.folderAsk = { Alice: `only:[ASK_FOLDER ${other}]` };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const [alice] = agentMessages(conv);
    // Not a pass (the chat draws a passed reply as one line, without its parts): it asks.
    expect(alice).toMatchObject({ asked: true, passed: false, parts: [{ type: 'folder', path: other, status: 'pending' }] });
    expect(conv.pause?.askers).toEqual(['a']);
  });

  it('tells every agent below full access how to ask', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', agents: agents.slice(0, 1) } as never);
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(calls[0]!.systemPrompt).toContain('[ASK_FOLDER <absolute path>]');
  });
});
