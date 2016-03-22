# pull-git-repo

Wrap a module implementing the [abstract-pull-git-repo][] interface, adding
utility methods

## API

Below, `source(obj)` means returns a [readable stream][pull-stream] for objects of type `obj`

#### `Repo(repo): repo`

Mixin `pull-git-repo` methods into `repo`

#### `repo.readCommit(rev): source({name, value})`

Read a commit. Returns a readable stream of objects for fields in the
commit.  The commit message is treated as a field of type `"title"` for the
first line, and a field of type `"body"` for the rest.

- `rev`: SHA1 hash of the commit to read, or a ref pointing to it
- `name`: name of a field, one of
    `["tree", "parent", "author", "committer", "body"]`
- `value`: string value of the field

#### `repo.readTag(rev): source({name, value})`

Read a tag. Returns a readable stream of objects for fields in the
tag.  The tag message is treated as a field of type `"title"` for the
first line, and a field of type `"body"` for the rest.

- `rev`: SHA1 hash of the tag to read, or a ref pointing to it
- `name`: name of a field, one of
    `["object", "type", "tag", "tagger", "title", "body"]`
- `value`: string value of the field

#### `repo.readTree(rev): source({id, mode, name})`

Get a tree and stream its entries

#### `repo.readDir(rev, path): source({id, mode, name})`

Stream entries from a tree down a given path

#### `repo.readLog(head): source(hash)`

Stream commit IDs of the repo, following the commit history backwards

- `head`: hash or rev of the commit from which to start reading history

#### `repo.resolveRef(name, cb(err, hash))`

Get the hash that a ref points to. Errors if the ref is not found.

#### `repo.getRef(name, cb(err, object, id))`

Get a git object

- `name`: name of a branch, tag, or ref pointing to the object,
  or SHA1 of the object

#### `repo.getCommit(rev, cb(err, object, id))`

Get a commit object. If the object refered to by `rev` is a tag, get the commit
that it points to.

#### `repo.getTag(rev, cb(err, object))`

Get a tag object.

#### `repo.getTree(rev, cb(err, object))`

Get a tree object. If `rev` refers to a commit or tag, get the tree that it
points to.

#### `repo.getCommitParsed(rev, cb(err, commit))`

Get a commit buffered and parsed into a JSON object

- `commit.id`: ID of the commit
- `commit.tree`: ID of the tree of the commit
- `commit.parents`: IDs of parent commits. There will be more than one if it is
  a merge commit.
- `commit.title`: first line of the commit message
- `commit.body`: text from the commit message following the first line and an
  optional blank line
- `commit.author`: `user` object for info about the commit author
- `commit.committer`: `user` object for info about the committer
- `commit.separateAuthor`: convenience value indicating `commit.author` and
  `commit.committer` are different

Example:

```js
{
  "parents": [
    "f7c37c43a136064e07328ee7501fad8ed7bcc4d6"
  ],
  "author": {
    "str": "root <root@localhost> 1455078653 -0500",
    "name": "root",
    "email": "root@localhost",
    "date": new Date(1455078653)
  },
  "committer": {
    "str": "root <root@localhost> 1455078653 -0500",
    "name": "root",
    "email": "root@localhost",
    "date": new Date(1455078653)
  },
  "body": "",
  "id": "9a385c1d6b48b7f472ac507a3ec08263358e9804",
  "tree": "68aba62e560c0ebc3396e8ae9335232cd93a3f60",
  "title": "Initial commit",
  "separateAuthor": false
}
```

#### `repo.getFile(rev, path, cb(err, {length, mode, read)`

Get a file from tree at the given path.

`length`: size of the file in bytes
`mode`: mode of the file, e.g. `"100644"`
`read`: readable stream of the file's contents

#### `repo.isCommitHash(str): bool`

[pull-stream]: https://github.com/dominictarr/pull-stream/
[abstract-pull-git-repo]: https://github.com/clehner/abstract-pull-git-repo

## License

Copyright (c) 2016 Charles Lehner

Usage of the works is permitted provided that this instrument is
retained with the works, so that any entity that uses the works is
notified of this instrument.

DISCLAIMER: THE WORKS ARE WITHOUT WARRANTY.
