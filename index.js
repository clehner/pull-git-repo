var buffered = require('pull-buffered')
var pull = require('pull-stream')

var R = {}

module.exports = function (repo) {
  for (var k in R)
    repo[k] = R[k]
  return repo
}

function split2(str, delim) {
  var i = str.indexOf(delim || ' ')
  return i === -1 ? [str] : [str.substr(0, i), str.substr(i + 1)]
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

function isCommitHash(str) {
  return /[0-9a-f]{20}/.test(str)
}

R.resolveRef = function (name, cb) {
  if (!name)
    return cb(new Error('Invalid name'))

  if (isCommitHash(name))
    return cb(null, name)

  if (name.indexOf('/') === -1)
    name = 'refs/heads/' + name

  var readRef = this.refs()
  readRef(null, function next(end, ref) {
    if (end)
      cb(new Error('Ref ' + ref + ' not found'))
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
    this.getObject(hash, cb)
      // if (!err && !hash)
        // return cb(new Error('Ref ' + name + ' not found'))
  }.bind(this))
}

R.readCommit = R.readTag = function (hash) {
  var ended, b, next

  return function read(end, cb) {
    if (ended) return cb(ended)
    if (b) return next(end, cb)
    this.getObject(hash, function (err, object) {
      if (err) return cb(err)
      b = buffered(object.read)
      next(null, cb)
    })
  }.bind(this)

  function next(end, cb) {
    b.lines(end, function (err, line) {
      if (line) {
        var s = split2(line)
        cb(null, {name: s[0], value: s[1]})
      } else {
        ended = true
        cb(null, {name: 'body', read: b.passthrough})
      }
    })
  }
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

R.getTree = function (ref, cb) {
  var self = this
  this.getRef(ref, function gotRef(err, object) {
    if (err) return cb(err)
    switch (object.type) {
      case 'tree':
        return cb(null, object)
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

R.readDir = function (branch, path) {
  var readTree = this.readTree(branch)

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
    this.readDir(branch, path),
    pull.filter(function (file) {
      return file.name === filename
    }),
    pull.take(1),
    pull.collect(function (err, files) {
      if (err) return cb(err)
      var file = files[0]
      if (!file === 0)
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

R.readLog = function (head, limit) {
  var self = this
  return function (end, cb) {
    self.getRef(head, function (err, object) {
      if (err) return cb(err)
      readCommitOrTagProperty(object, 'parent', function (err, hash) {
        cb(err, head = hash)
      })
    })
  }
}
