var buffered = require('pull-buffered')
var pull = require('pull-stream')
var util = require('util')
var toPull = require('stream-to-pull-stream')
var packidx = require('git-packidx-parser')
var pack = require('pull-git-pack')
var createGitHash = require('pull-hash/ext/git')
var asyncMemo = require('asyncmemo')
var multicb = require('multicb')
var cache = require('pull-cache')

var R = {}

module.exports = Repo
function Repo(repo) {
  if (repo._Repo == Repo)
    return repo
  repo._Repo = Repo

  for (var k in R)
    repo[k] = R[k]
  repo.getPackIndexCached = asyncMemo(R.getPackIndexParsed)
  repo.getPackfileCached = asyncMemo(R.getPackfileBufs)
  repo._cachedObjects = {}
  repo._unpackedObjects = {}

  if (!repo.packs)
    repo.packs = pull.empty

  return repo
}

module.exports.NotFoundError = NotFoundError

function NotFoundError(msg) {
  var err = Error.call(this, msg)
  err.name = NotFoundError.name
  return err
}
util.inherits(NotFoundError, Error)

function split2(str, delim) {
  var i = str.indexOf(delim || ' ')
  return i === -1 ? [str, ''] : [str.substr(0, i), str.substr(i + 1)]
}

function readNext(fn) {
  var next
  return function (end, cb) {
    if (next) return next(end, cb)
    fn(function (err, _next) {
      if (err) return cb(err)
      next = _next
      next(null, cb)
    })
  }
}

function buffer(read, cb) {
  pull(
    read,
    pull.collect(function (err, bufs) {
      cb(err, bufs && Buffer.concat(bufs))
    })
  )
}

function sliceBufs(bufs, start, len) {
  var outBufs = []
  for (var i = 0; i < bufs.length; i++) {
    var buf = bufs[i]
    if (start >= buf.length) {
      start -= buf.length
    } else if (start === 0) {
      if (buf.length > len) {
        outBufs.push(buf)
        len -= buf.length
      } else if (buf.length === len) {
        outBufs.push(buf)
        break
      } else {
        outBufs.push(buf.slice(0, len))
        break
      }
    } else {
      var sliceLen = Math.min(len, buf.length - start)
      outBufs.push(buf.slice(start, start + sliceLen))
      start = 0
      len -= sliceLen
      if (len === 0)
        break
    }
    return outBufs
  }
}

var refLabels = {
  heads: 'Branches',
  tags: 'Tags'
}

R.getRefNames = function (pretty, cb) {
  if (typeof pretty == 'function' && !cb)
    cb = pretty, pretty = false
  var refs = {}
  pull(
    this.refs(),
    pull.drain(function (ref) {
      var m = ref.name.match(/^refs\/([^\/]*)\/(.*)$/) || [,, ref.name]
      var group = m[1]
      var name = m[2]
      if (pretty)
        group = refLabels[group] || group
      ;(refs[group] || (refs[group] = [])).push(name)
    }, function (err) {
      for (var group in refs)
        refs[group].sort()
      cb(err, refs)
    })
  )
}

Repo.parseCommitOrTag = function (object) {
  var body = '', state = 'fields'
  var done = multicb({ pluck: 1, spread: true })
  var b = pull(
    object.read,
    createGitHash(object, done()),
    buffered
  )
  var onReadEnd = done()
  done(function (err, hash, cb) {
    return cb(err, {name: 'id', value: hash})
  })
  return function read(end, cb) {
    switch (state) {
      case 'body':
        state = 'id'
        return buffer(b.passthrough, function (err, data) {
          if (err) return cb(err)
          body += data.toString('utf8')
          cb(null, {name: 'body', value: body})
        })
      case 'id':
        state = 'end'
        return onReadEnd(null, cb)
      case 'end':
        return cb(true)
      case 'fields':
        return b.lines(end, function (err, line) {
          if (err) return cb(err)
          if (line === '') {
            state = 'title'
            read(null, cb)
          } else {
            var s = split2(line)
            var name = s[0]
            var value = s[1]
            switch (name) {
              case 'author':
              case 'committer':
              case 'tagger':
                var m = value.match(/^((.*) <(.*)>) (.*) (.*)$/) || [, value]
                value = {
                  str: value,
                  nameEmail: m[1],
                  name: m[2],
                  email: m[3],
                  date: new Date(m[4] * 1000)
                }
            }
            cb(null, {name: name, value: value})
          }
        })
      case 'title':
        state = 'newline'
        return b.lines(end, function (err, line) {
          if (err) return cb(err)
          cb(null, {name: 'title', value: line})
        })
      case 'newline':
        state = 'body'
        return b.lines(end, function (err, line) {
          if (err === true) {
            state = 'end'
            return onReadEnd(null, cb)
          }
          if (err) return cb(err)
          if (line === '') {
            read(end, cb)
          } else {
            body = line + '\n'
            read(end, cb)
          }
        })
      default:
        return cb(new Error('Bad state: ' + state))
    }
  }
}

R.isCommitHash = function (str) {
  return /[0-9a-f]{20}/.test(str)
}

R.resolveRef = function (name, cb) {
  if (!name)
    return cb(new Error('Invalid name \'' + name + '\''))

  if (this.isCommitHash(name))
    return cb(null, name)

  var readRef = this.refs()
  readRef(null, function next(end, ref) {
    if (end)
      cb(new NotFoundError('Ref \'' + name + '\' not found'))
    else if (ref.name === name
        || ref.name === 'refs/heads/' + name
        || ref.name === 'refs/tags/' + name)
      readRef(true, function (err) {
        cb(err === true ? null : err, ref.hash)
      })
    else
      readRef(null, next)
  })
}

R.getRef = function (name, cb) {
  this.resolveRef(name, function (err, hash) {
    if (err) return cb(err)
    this.getObjectFromAny(hash, function (err, object) {
      cb(err, object, hash)
    })
  }.bind(this))
}

R.readCommit = function (rev) {
  var self = this
  return readNext(function (cb) {
    self.getCommit(rev, function (err, object) {
      if (err) return cb(err)
      cb(null, Repo.parseCommitOrTag(object))
    })
  })
}

R.readTag = function (rev) {
  var self = this
  return readNext(function (cb) {
    self.getCommit(rev, function (err, object) {
      if (err) return cb(err)
      cb(null, Repo.parseCommitOrTag(object))
    })
  })
}

function readCommitOrTagProperty(object, property, cb) {
  var b = buffered(object.read)
  var readLine = b.lines
  readLine(null, function next(err, line) {
    if (err) return cb(err)
    if (!line) return readLine(true, cb)
    var s = split2(line)
    if (s[0] === property) {
      b.passthrough(true, function (err) {
        cb(err === true ? null : err, s[1])
      })
    } else {
      readLine(null, next)
    }
  })
}

R.getCommitParsed = function (rev, cb) {
  this.getCommit(rev, function (err, object, hash) {
    if (err) return cb(err)
    Repo.getCommitParsed(object, hash, cb)
  })
}

Repo.getCommitParsed = function (object, hash, cb) {
  if (!cb && typeof hash == 'function')
    cb = hash, hash = null
  var commit = {
    parents: [],
    author: {},
    committer: {},
    body: ''
  }
  return pull(
    Repo.parseCommitOrTag(object),
    pull.drain(function (field) {
      if (field.name == 'parent')
        commit.parents.push(field.value)
      else
        commit[field.name] = field.value
    }, function (err) {
      commit.separateAuthor =
        (commit.author.nameEmail !== commit.committer.nameEmail)
      commit.separateAuthorDate =
        (+commit.author.date !== +commit.committer.date)
      cb(err, commit)
    })
  )
}

R.getTree = function (ref, cb) {
  var self = this
  this.getRef(ref, function gotRef(err, object, hash) {
    if (err) return cb(err)
    switch (object.type) {
      case 'tree':
        return cb(null, object, hash)
      case 'commit':
        return readCommitOrTagProperty(object, 'tree', function (err, hash) {
          if (err) return cb(err)
          self.getRef(hash, gotRef)
        })
      case 'tag':
        return readCommitOrTagProperty(object, 'object', function (err, hash) {
          if (err) return cb(err)
          self.getRef(hash, gotRef)
        })
      default:
        return cb(new Error('Expected tree, got ' + object.type))
    }
  })
}

R.readTree = function (hash) {
  var b, readStr, readHash, ended
  var self = this

  return function (end, cb) {
    if (ended) return cb(ended)
    if (b) return next(end, cb)
    self.getTree(hash, function gotObject(err, object) {
      if (err) return cb(err)
      b = buffered(object.read)
      readStr = b.delimited(0)
      readHash = b.chunks(20)
      next(null, cb)
    })
  }

  function next(end, cb) {
    readStr(end, function (err, fileInfo) {
      if (err) return cb(err)
      readHash(end, function (err, hash) {
        if (err) return cb(err)
        var s = split2(fileInfo)
        cb(null, {
          id: hash.toString('hex'),
          mode: parseInt(s[0], 8),
          name: s[1]
        })
      })
    })
  }
}

R.readDir = function (rev, path) {
  var readTree = this.readTree(rev)
  var self = this
  path = (typeof path == 'string') ? path.split(/\/+/) : path.slice()
  return readNext(function next(cb) {
    if (path.length === 0) {
      // this is the directory the caller wants to read
      return cb(null, readTree)
    }

    // find the next file in the path
    pull(
      readTree,
      pull.filter(function (file) {
        return file.name === path[0] && file.mode == 040000
      }),
      pull.take(1),
      pull.collect(function (err, files) {
        if (err) return cb(err)
        var file = files[0]
        if (!file) return cb(new Error('File \'' + path[0] + '\' not found'))
        path.shift()
        readTree = self.readTree(file.id)
        next(cb)
      })
    )
  })
}

R.getFile = function (rev, path, cb) {
  var self = this
  path = (typeof path == 'string') ? path.split(/\/+/) : path.slice()
  var filename = path.pop()

  pull(
    this.readDir(rev, path),
    pull.filter(function (file) {
      return file.name === filename
    }),
    pull.take(1),
    pull.collect(function (err, files) {
      if (err) return cb(err)
      var file = files[0]
      if (!file)
        return cb(new Error('File not found'))
      self.getObjectFromAny(file.id, function (err, object) {
        if (err) return cb(err)
        cb(null, {
          length: object.length,
          read: object.read,
          mode: parseInt(file.mode, 8)
        })
      })
    })
  )
}

R.getCommit = function (ref, cb) {
  var self = this
  this.getRef(ref, function gotRef(err, object, hash) {
    if (err) return cb(err)
    switch (object.type) {
      case 'commit':
        return cb(null, object, hash)
      case 'tag':
        return readCommitOrTagProperty(object, 'object', function (err, hash) {
          if (err) return cb(err)
          self.getRef(hash, gotRef)
        })
      default:
        return cb(new Error('Expected commit, got ' + object.type))
    }
  })
}

R.readLog = function (head) {
  var self = this
  var object, ended
  return function read(end, cb) {
    if (ended) return cb(ended)
    if (!head) return cb(true)
    if (!object)
      self.getRef(head, function (err, obj, hash) {
        object = obj
        cb(ended = err, head = hash)
      })
    else
      readCommitOrTagProperty(object, 'parent', function (err, hash) {
        object = null
        head = hash
        if (ended = err) cb(err)
        else read(null, cb)
      })
  }
}

R.getPackIndexParsed = function (id, cb) {
  this.getPackIndex(id, function (err, read) {
    if (err) return cb(err)
    var s = packidx()
    s.on('error', cb)
    s.on('data', function (idx) { cb(null, idx) })
    pull(read, toPull.sink(s))
  })
}

R.findPackedObject = function (hash, cb) {
  var self = this
  var id = new Buffer(hash, 'hex')
  var read = this.packs()
  read(null, function next(end, pack) {
    if (end) return cb(new Error('Object ' + hash + ' not found in pack'))
    self.getPackIndexCached(pack.idxId, function (err, idx) {
      if (err) return cb(err)
      var offset = idx.find(id)
      if (!offset) return read(null, next)
      read(true, function (err) {
        if (err && err !== true) return cb(err)
        offset.packId = pack.packId
        cb(null, offset)
      })
    })
  })
}

function expandObject(obj) {
  return {
    type: obj.type,
    length: obj.length,
    read: pull.values(obj.bufs)
  }
}

R.getObjectFromPack = function (hash, cb) {
  var obj = this._cachedObjects[hash]
  if (obj) return cb(null, expandObject(obj))
  var self = this
  this.findPackedObject(hash, function (err, offset) {
    if (err) return cb(err)
    self.getPackfileCached(offset.packId, function (err, bufs) {
      if (err) return cb(err)
      bufs = Buffer.concat(bufs)
      bufs = [bufs.slice(offset.offset, offset.next || bufs.length)]
      pull(
        pull.values(bufs),
        pack.decodeObject({verbosity: 0}, self, function (err, obj) {
          if (err) return cb(err)
          pull(obj.read, pull.collect(function (err, objBufs) {
            if (err) return cb(err)
            cb(null, expandObject(self._cachedObjects[hash] = {
              type: obj.type,
              length: obj.length,
              sha1: hash,
              bufs: objBufs
            }))
          }))
        })
      )
    })
  })
}

R.hasObjectFromPack = function (hash, cb) {
  if (hash in this._cachedObjects) return cb(null, true)
  var self = this
  this.findPackedObject(hash, function (err, offset) {
    cb(err, !!offset)
  })
}

R.getPackfileBufs = function (packId, cb) {
  this.getPackfile(packId, function (err, packfile) {
    if (err) return cb(err)
    pull(packfile, pull.collect(cb))
  })
}

R.unpackPack = function (packId, _cb) {
  var cachedSource = this._unpackedObjects[packId]
  if (cachedSource) return _cb(null, cachedSource())
  var self = this
  var onEnd = multicb()
  var cb = onEnd()
  onEnd(_cb)
  this.getPackfile(packId, function (err, packfile) {
    if (err) return cb(err)
    var source = pull(
      pack.decode(null, self, onEnd(), packfile),
      pull.asyncMap(function (obj, mapCb) {
        var done = multicb({ pluck: 1, spread: true })
        pull(
          obj.read,
          createGitHash(obj, done()),
          pull.collect(done())
        )
        done(function (err, hash, bufs) {
          if (err) mapCb(err)
          mapCb(null, self._cachedObjects[hash] = {
            type: obj.type,
            length: obj.length,
            sha1: hash,
            bufs: bufs
          })
        })
      })
    )
    cachedSource = self._unpackedObjects[packId] = cache(source)
    _cb(null, cachedSource())
  })
}

R.getObjectFromAny = function (hash, cb) {
  this.getObject(hash, function (err, obj) {
    if (obj)
      cb(null, obj)
    else
      this.getObjectFromPack(hash, cb)
  }.bind(this))
}

R.hasObjectFromAny = function (hash, cb) {
  this.hasObject(hash, function (err, has) {
    if (has)
      cb(null, true)
    else
      this.hasObjectFromPack(hash, cb)
  }.bind(this))
}
