var test = require('tape')
var repoData = require('abstract-pull-git-repo/tests/repo')
var pull = require('pull-stream')
var pgr = require('.')

function objectEncoding(obj) {
  return obj.type == 'tree' ? 'hex' : 'utf8'
}

function pullObject(obj) {
  return {
    type: obj.type,
    length: obj.length,
    read: pull.once(new Buffer(obj.data, objectEncoding(obj)))
  }
}

function pullObjectSplit(obj) {
  var buf = new Buffer(obj.data, objectEncoding(obj))
  return {
    type: obj.type,
    length: obj.length,
    read: pull.values([].map.call(buf, function (c) {
      return new Buffer([c])
    }))
  }
}

function testMulti(msg, hash, cb) {
  var obj = repoData.objects[hash]
  if (!obj) return t.fail('Missing object ' + hash)
  test(msg, function (t) {
    t.test('all at once', function (t) {
      cb(t, pullObject(obj))
    })
    t.test('character by character', function (t) {
      cb(t, pullObjectSplit(obj))
    })
  })
}

var treeId = '96e10162dd55da56a440c5285ea9e7d4abf55d77'
testMulti('pass through an object', treeId, function (t, object) {
  pull(
    object.read,
    pull.collect(function (err, bufs) {
      var buf = Buffer.concat(bufs, object.length)
      var data = buf.toString(objectEncoding(object))
      t.equals(data, repoData.objects[treeId].data)
      t.end()
    })
  )
})

// TODO: test things
