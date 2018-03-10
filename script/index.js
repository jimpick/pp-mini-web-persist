const html = require('choo/html')
const devtools = require('choo-devtools')
const choo = require('choo')
const hypermergeMicro = require('./hypermerge-micro')
const equal = require('deep-equal')
const websocket = require('websocket-stream')
const pump = require('pump')
const prettyHash = require('pretty-hash')
const storage = require('random-access-idb')('pp-mini')

require('events').EventEmitter.prototype._maxListeners = 100

function mainView (state, emit) {
  const {selectedColor, doc, pixelDoc} = state

  if (!doc) return html`Loading...`

  const colors = ['r', 'g', 'b', 'w']
  const colorEles = colors.map(color => {
    const selected = color === selectedColor ? "selected" : null

    return html`
      <div
        class="color ${selected}"
        data-color="${color}"
        onclick="${onclick}">
      </div>
    `

    function onclick () {
      emit('pickColor', color)
    }
  })

  const pixelEles = []
  for (let y = 0; y <= 1; y++) {
    for (let x = 0; x <= 1; x++) {
      const color = doc[`x${x}y${y}`]
      const pixelEle = html`
        <div
          class="pixel"
          id="x${x}y${y}"
          data-color="${color}"
          onclick="${onclick}">
        </div>
      `
      pixelEles.push(pixelEle)

      function onclick () {
        emit('setPixelColor', x, y, selectedColor)
      }
    }
  }
  
  function submit (e) {
    const key = e.target.children[0].value
    emit('addActor', key)    
    console.log('jim add actor', key)
    e.preventDefault()
  }

  const submitForm = html`
    <form onsubmit=${submit}>
      <input type="text">
    </form>
  `
  
  const hm = pixelDoc.hm
  const debugHtml = html`
    <div>
      <hr>
      ${formatPeer(hm.source)}
      ${hm.local ? formatPeer(hm.local) : ''}
      ${Object.keys(hm.peers).map(key => formatPeer(hm.peers[key]))}
    </div>
  `
  
  function formatPeer(feed) {
    return html`
      <span>
        ${feed.key.toString('hex')}
        ${prettyHash(feed.discoveryKey)}
        ${feed.length}
        <br>
      </span>
    `
  }
  
  return html`
    <body>
      <div class="info">
        Source: ${hm.source.key.toString('hex')}<br>
        Archiver: ${hm.getArchiverKey().toString('hex')}<br>
        ${debugHtml}
      </div>
      <div class="container">
        <div class="palette">
          ${colorEles}
        </div>
        <div class="pixels">
          ${pixelEles}
        </div>
      </div>
    </body>
  `
}

class PixelDoc {
  constructor (update) {
    this.update = update
    const key = localStorage.getItem('key')
    const hm = hypermergeMicro(storage, {key, debugLog: true})
    hm.on('debugLog', console.log)
    hm.on('ready', this.ready.bind(this))
    this.hm = hm
  }

  ready () {
    const hm = this.hm
    console.log('Jim ready', hm.key.toString('hex'))
    localStorage.setItem('key', hm.key.toString('hex'))
    this.setupGlue()
    hm.doc.registerHandler(doc => {
      this.update(doc)
    })

    if (hm.source.length === 0) {
      hm.change('blank canvas', doc => {
        doc.x0y0 = 'w'
        doc.x0y1 = 'w'
        doc.x1y0 = 'w'
        doc.x1y1 = 'w'
      })
    }

    console.log('Ready', hm.get())
    this.update(hm.get())

    hm.multicore.on('announceActor', message => {
      console.log('announceActor', message)
      hm.connectPeer(message.key)
    })

    const archiverKey = hm.getArchiverKey().toString('hex')
    const hostname = document.location.hostname
    const url = `wss://${hostname}/archiver/${archiverKey}`
    const stream = websocket(url)
    // this.ws = websocket(url)
    // this.ws.write('Jim test')
    pump(
      stream,
      // hm.multicore.archiver.replicate({live: true, encrypt: false}),
      // hm.multicore.archiver.replicate({key: hm.multicore.archiver.changes.key}),
      // hm.multicore.archiver.replicate({key: hm.key}),
      // hm.multicore.archiver.replicate({live: true}),
      hm.multicore.archiver.replicate({encrypt: false}),
      stream
    )
  }

  setPixelColor (x, y, color) {
    this.hm.change(doc => { doc[`x${x}y${y}`] = color })
    // this.ws.write(`setPixelColor ${x} ${y} ${color}`)
  }
  
  addActor (key) {
    this.hm.connectPeer(key)
  }
  
  setupGlue () {
    const hm = this.hm
    const self = this
    hm.getMissing(() => {
      // Setup 'glue' actors data structure in document
      let actorIncludedInDoc = false
      setTimeout(() => {
        updateActorGlue(hm.get())
        hm.doc.registerHandler(updateActorGlue)
        this.update(hm.get())
      }, 1000)

      function updateActorGlue (doc) {
      if (hm.findingMissingPeers) {
        log('Still finding missing peers')
        return // Still fetching dependencies
      }
      const actorId = hm.local ? hm.local.key.toString('hex')
        : hm.source.key.toString('hex')
      if (hm.local && !actorIncludedInDoc) {
        actorIncludedInDoc = true
        if (hm.local.length === 0) {
          hm.change(doc => {
            if (!doc.actors) {
              doc.actors = {}
              doc.actors[actorId] = {}
            }
            const seenActors = updateSeenActors(doc)
            if (seenActors) {
              doc.actors[actorId] = seenActors
            }
            // log(`Update local actors ${JSON.stringify(doc.actors)}`)
          })
          console.log(`Updated actors list (new actor)`)
        }
      } else {
        const seenActors = updateSeenActors(doc)
        if (seenActors) {
          hm.change(doc => {
            if (!doc.actors) {
              doc.actors = {}
            }
            doc.actors[actorId] = seenActors
          })
          console.log(`Updated actors list`)
        }
      }

      self.update(hm.get())

      function updateSeenActors (doc) {
        if (!actorId) return null
        const actors = doc.actors || {}
        let prevSeenActors = actors[actorId] || {}
        if (prevSeenActors) {
          prevSeenActors = Object.keys(prevSeenActors).reduce(
            (acc, key) => {
              if (key === '_objectId') return acc
              return Object.assign({}, acc, {[key]: prevSeenActors[key]})
            },
            {}
          )
        }
        const keys = Object.keys(actors)
          .filter(key => (key !== actorId) && (key !== '_objectId'))
        // log(keys.join(','))
        const seenActors = keys.reduce(
          (acc, key) => Object.assign({}, acc, {[key]: true}),
          {}
        )
        return !equal(seenActors, prevSeenActors) ? seenActors : null
      }
    }
    })
  }
}

function pixelStore (state, emitter) {
  state.pixelDoc = new PixelDoc(doc => {
    state.doc = doc
    console.log('Jim update')
    emitter.emit('render')
  })
  state.selectedColor = 'r'

  emitter.on('pickColor', color => {
    state.selectedColor = color
    emitter.emit('render')
  })
  emitter.on('setPixelColor', (x, y, color) => {
    state.pixelDoc.setPixelColor(x, y, color)
  })
  emitter.on('addActor', key => {
    state.pixelDoc.addActor(key)
  })
}

const app = choo()
app.use(devtools())
app.use(pixelStore)
app.route('/', mainView)
app.mount('body')
