var buffered = require('pull-buffered')
var pull = require('pull-stream')
var util = require('util')

var R = {}

module.exports = function (repo) {
  for (var k in R)
    repo[k] = R[k]
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

function parseCommitOrTag(object, id) {
  var body = '', state = 'begin'
  var b = buffered(object.read)
  return function read(end, cb) {
    switch (state) {
      case 'begin':
        state = 'fields'
        return cb(null, {name: 'id', value: id})
      case 'body':
        state = 'end'
        return buffer(b.passthrough, function (err, data) {
          if (err) return cb(err)
          body += data.toString('utf8')
          cb(null, {name: 'body', value: body})
        })
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
                var m = value.match(/^(.*) <(.*)> (.*) (.*)$/) || [, value]
                value = {
                  str: value,
                  name: m[1],
                  email: m[2],
                  date: new Date(m[3] * 1000)
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
          if (err) return cb(err)
          if (line === '') {
            read(end, cb)
          } else {
            body = line + '\n'
            read(end, cb)
          }
        })
      default:
        return cb(state)
    }
  }
}

R.isCommitHash = function (str) {
  return /[0-9a-f]{20}/.test(str)
}

R.resolveRef = function (name, cb) {
  if (!name)
    return cb(new Error('Invalid name'))

  if (this.isCommitHash(name))
    return cb(null, name)

  if (name.indexOf('/') === -1)
    name = 'refs/heads/' + name

  var readRef = this.refs()
  readRef(null, function next(end, ref) {
    if (end)
      cb(new NotFoundError('Ref \'' + name + '\' not found'))
    else if (ref.name !== name)
      readRef(null, next)
    else
      readRef(true, function (err) {
        cb(err === true ? null : err, ref.hash)
      })
  })
}

R.getRef = function (name, cb) {
  this.resolveRef(name, function (err, hash) {
    if (err) return cb(err)
    this.getObject(hash, function (err, object) {
      cb(err, object, hash)
    })
  }.bind(this))
}

R.readCommit = function (rev) {
  var self = this
  return readNext(function (cb) {
    self.getCommit(rev, function (err, object, hash) {
      if (err) return cb(err)
      cb(null, parseCommitOrTag(object, hash))
    })
  })
}

R.readTag = function (rev) {
  var self = this
  return readNext(function (cb) {
    self.getCommit(rev, function (err, object, hash) {
      if (err) return cb(err)
      cb(null, parseCommitOrTag(object, hash))
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
      object.read(true, function (err) {
        cb(err === true ? null : err, s[1])
      })
    } else {
      readLine(null, next)
    }
  })
}

R.getCommitParsed = function (ref, cb) {
  var commit = {
    parents: [],
    author: {},
    committer: {},
    body: ''
  }
  pull(
    this.readCommit(ref),
    pull.drain(function (field) {
      if (field.name == 'parent')
        commit.parents.push(field.value)
      else
        commit[field.name] = field.value
    }, function (err) {
      commit.separateAuthor = (commit.author.str !== commit.committer.str)
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
          mode: s[0],
          name: s[1]
        })
      })
    })
  }
}

R.readDir = function (rev, path) {
  var readTree = this.readTree(rev)

  if (path.length === 0 || path === '/')
    return readTree

  path = (typeof path == 'string') ? path.split(/\/+/) : path.slice()

  var self = this
  return readNext(function (cb) {
    readTree(null, function next(err, file) {
      if (err) return cb(err)
      if (file.name !== path[0])
        return readTree(null, next)
      if (file.mode !== '040000')
        return cb(new Error('Bad path'))
      // cancel reading current tree
      readTree(true, function (err) {
        if (err) return cb(err)
        path.shift()
        // start reading tree of found file
        readTree = self.readTree(file.hash)
      })
    })
  })
}

R.getFile = function (branch, path, cb) {
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
      self.getObject(file.id, function (err, object) {
        if (err) return cb(err)
        cb(null, {
          length: object.length,
          read: object.read,
          mode: file.mode
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
