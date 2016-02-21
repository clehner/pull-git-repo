# pull-git-repo

Wrap a module implementing the [abstract-pull-git-repo][] interface, adding
utility methods

## API

Below, `source(obj)` means returns a [readable stream][pull-stream] for objects of type `obj`

#### `repo.readCommit(hash): source({name, value || read})`
#### `repo.readTag(hash): source({name, value || read})`

Read a commit or tag. Returns a readable stream of objects for fields in the
commit.  The commit/tag message is treated as a field of type `"body"` except
it comes with a `read` function instead of a `value` string.

- `hash`: SHA1 hash ID of the commit to read
- `name`: name of a field, one of
    `["tree", "parent", "author", "committer", "body"]`
- `value`: string value of the field
- `read`: source for the raw data of the commit/tag body, if `name == "body"`

#### `repo.readTree(rev): source({id, mode, name})`

#### `repo.readDir(branch, path): source({id, mode, name})`

#### `repo.getTree(rev, cb(err, object))`

#### `repo.getFile(branch, path, cb(err, {length, mode, read})`

#### `repo.readLog(head, limit): source(hash)`

#### `repo.resolveRef(name, cb)`

#### `repo.getRef(name, cb)`

[pull-stream]: https://github.com/dominictarr/pull-stream/
[abstract-pull-git-repo]: https://github.com/clehner/abstract-pull-git-repo

## License

Copyright (c) 2016 Charles Lehner

Usage of the works is permitted provided that this instrument is
retained with the works, so that any entity that uses the works is
notified of this instrument.

DISCLAIMER: THE WORKS ARE WITHOUT WARRANTY.
