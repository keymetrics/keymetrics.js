
'use strict'

const axios = require('axios')
const AuthStrategy = require('./auth_strategies/strategy')
const constants = require('../constants')
const logger = require('debug')('kmjs:network')
const loggerHttp = require('debug')('kmjs:network:http')
const loggerWS = require('debug')('kmjs:network:ws')
const WS = require('./utils/websocket')
const EventEmitter = require('eventemitter2')
const async = require('async')

const BUFFERIZED = -1

module.exports = class NetworkWrapper {
  constructor (km, opts) {
    logger('init network manager')
    opts.baseURL = opts.API_URL || 'https://api.keymetrics.io'
    this.opts = opts
    this.tokens = {
      refresh_token: null,
      access_token: null
    }
    this.km = km
    this._buckets = []
    this._queue = []
    this._axios = axios.create(opts)
    this._queueWorker = setInterval(this._queueUpdater.bind(this), 10)

    // if we are running on nodejs, we need to unref the worker : why ?
    // For example, in a CLI, it will not close after executing because
    // there is still the setInterval scheduled (see how the event loop works)
    if (typeof this._queueWorker.unref === 'function') {
      this._queueWorker.unref()
    }
    this._websockets = []

    this.realtime = new EventEmitter({
      wildcard: true,
      delimiter: ':',
      newListener: false,
      maxListeners: 20
    })
    this.realtime.subscribe = this.subscribe.bind(this)
    this.realtime.unsubscribe = this.unsubscribe.bind(this)
    this.authenticated = false
  }

  _queueUpdater () {
    if (this.authenticated === false) return

    if (this._queue.length > 0) {
      logger(`Emptying requests queue (size: ${this._queue.length})`)
    }

    // when we are authenticated we can clear the queue
    while (this._queue.length > 0) {
      let promise = this._queue.shift()
      // make the request
      this.request(promise.request).then(promise.resolve, promise.reject)
    }
  }

  /**
   * Resolve the endpoint of the node to make the request to
   * because each bucket might be on a different node
   * @param {String} bucketID the bucket id
   *
   * @return {Promise}
   */
  _resolveBucketEndpoint (bucketID) {
    if (!bucketID) return Promise.reject(new Error(`Missing argument : bucketID`))
    return new Promise((resolve, reject) => {
      // try to resolve it from local cache
      const node = this._buckets
        .filter(bucket => bucket._id === bucketID)
        .map(bucket => bucket.node_cache)[0]
      // if found, return it
      if (node && node.endpoints) {
        return resolve(node.endpoints.web)
      }
      // otherwise we will need to resolve where the bucket is hosted
      this._axios.request({
        url: `/api/bucket/${bucketID}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.tokens.access_token}`
        }
      })
        .then((res) => {
          const bucket = res.data
          this._buckets.push(bucket)
          return resolve(bucket.node_cache.endpoints.web)
        }).catch(reject)
    })
  }

  /**
   * Send a http request
   * @param {Object} opts
   * @param {String} [opts.method=GET] http method
   * @param {String} opts.url the full URL
   * @param {Object} [opts.data] body data
   * @param {Object} [opts.params] url params
   *
   * @return {Promise}
   */
  request (httpOpts) {
    return new Promise((resolve, reject) => {
      async.series([
        // verify that we don't need to buffer the request because authentication
        next => {
          if (this.authenticated === true || httpOpts.authentication === false) return next()

          loggerHttp(`Queued request to ${httpOpts.url}`)
          this._queue.push({
            resolve,
            reject,
            request: httpOpts
          })
          // we need to stop the flow here
          return next(BUFFERIZED)
        },
        // we need to verify that the baseURL is correct
        (next) => {
          if (!httpOpts.url.match(/bucket\/[0-9a-fA-F]{24}/)) return next()
          // parse the bucket id from URL
          let bucketID = httpOpts.url.split('/')[3]
          // we need to retrieve where to send the request depending on the backend
          this._resolveBucketEndpoint(bucketID)
            .then(endpoint => {
              httpOpts.baseURL = endpoint
              // then continue the flow
              return next()
            }).catch(next)
        },
        // if the request has not been bufferized, make the request
        next => {
          // super trick to transform a promise response to a callback
          const successNext = res => next(null, res)
          loggerHttp(`Making request to ${httpOpts.url}`)

          if (!httpOpts.headers) {
            httpOpts.headers = {}
          }
          httpOpts.headers.Authorization = `Bearer ${this.tokens.access_token}`

          this._axios.request(httpOpts)
            .then(successNext)
            .catch((error) => {
              let response = error.response
              // we only need to handle when code is 401 (which mean unauthenticated)
              if (response && response.status !== 401) return next(response)
              loggerHttp(`Got unautenticated response, buffering request from now ...`)

              // we tell the client to not send authenticated request anymore
              this.authenticated = false

              loggerHttp(`Asking to the oauth flow to retrieve new tokens`)
              this.oauth_flow.retrieveTokens((err, data) => {
                // if it fail, we fail the whole request
                if (err) {
                  loggerHttp(`Failed to retrieve new tokens : ${err.message || err}`)
                  return next(response)
                }
                // if its good, we try to update the tokens
                loggerHttp(`Succesfully retrieved new tokens`)
                this._updateTokens(null, data, (err, authenticated) => {
                  // if it fail, we fail the whole request
                  if (err) return next(response)
                  // then we can rebuffer the request
                  loggerHttp(`Re-buffering call to ${httpOpts.url} since authenticated now`)
                  return this._axios.request(httpOpts).then(successNext).catch(next)
                })
              })
            })
        }
      ], (err, results) => {
        // if the flow is stoped because the request has been
        // buferred, we don't need to do anything
        if (err === BUFFERIZED) return
        return err ? reject(err) : resolve(results[2])
      })
    })
  }

  /**
   * Update the access token used by all the networking clients
   * @param {Error} err if any erro
   * @param {String} accessToken the token you want to use
   * @param {Function} [cb] invoked with <err, authenticated>
   * @private
   */
  _updateTokens (err, data, cb) {
    if (err) {
      console.error(`Error while retrieving tokens : ${err.message}`)
      return console.error(err.response ? err.response.data : err.stack)
    }
    if (!data || !data.access_token || !data.refresh_token) throw new Error('Invalid tokens')

    this.tokens = data

    loggerHttp(`Registered new access_token : ${data.access_token}`)
    this._axios.defaults.headers.common['Authorization'] = `Bearer ${data.access_token}`
    this._axios.request({
      url: '/api/bucket',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${data.access_token}`
      }
    }).then((res) => {
      this._buckets = res.data
      loggerHttp(`Cached ${res.data.length} buckets for current user`)
      this.authenticated = true
      return typeof cb === 'function' ? cb(null, true) : null
    }).catch((err) => {
      console.error('Error while retrieving buckets')
      console.error(err.response ? err.response.data : err)
      return typeof cb === 'function' ? cb(err) : null
    })
  }

  /**
   * Specify a strategy to use when authenticating to server
   * @param {String|Function} flow the name of the flow to use or a custom implementation
   * @param {Object} [opts]
   * @param {String} [opts.client_id] the OAuth client ID to use to identify the application
   *  default to the one defined when instancing Keymetrics and fallback to 795984050 (custom tokens)
   * @throws invalid use of this function, either the flow don't exist or isn't correctly implemented
   */
  useStrategy (flow, opts) {
    if (!opts) opts = {}
    // if client not provided here, use the one given in the instance
    if (!opts.client_id) {
      opts.client_id = this.opts.OAUTH_CLIENT_ID
    }

    // in the case of flow being a custom implementation
    if (typeof flow === 'function') {
      if (!(flow instanceof AuthStrategy)) throw new Error('You must implement the Flow interface to use it')
      let CustomFlow = flow
      this.oauth_flow = new CustomFlow(opts)
      return this.oauth_flow.retrieveTokens(this.km, this.updateTokens.bind(this))
    }
    // otherwise fallback on the flow that are implemented
    if (typeof AuthStrategy.implementations(flow) === 'undefined') {
      throw new Error(`The flow named ${flow} doesn't exist`)
    }
    let flowMeta = AuthStrategy.implementations(flow)

    // verify that the environnement condition is meet
    if (flowMeta.condition && constants.ENVIRONNEMENT !== flowMeta.condition) {
      throw new Error(`The flow ${flow} is reserved for ${flowMeta.condition} environ sment`)
    }
    let FlowImpl = flowMeta.nodule
    this.oauth_flow = new FlowImpl(opts)
    return this.oauth_flow.retrieveTokens(this.km, this._updateTokens.bind(this))
  }

  /**
   * Subscribe to realtime from bucket
   * @param {String} bucketId bucket id
   * @param {Object} [opts]
   *
   * @return {Promise}
   */
  subscribe (bucketId, opts) {
    return new Promise((resolve, reject) => {
      logger(`Request endpoints for ${bucketId}`)
      this.km.bucket.retrieve(bucketId)
        .then((res) => {
          let bucket = res.data

          let endpoint = bucket.node_cache.endpoints.realtime || bucket.node_cache.endpoints.web
          endpoint = endpoint.replace('http', 'ws')
          if (this.opts.IS_DEBUG) {
            endpoint = endpoint.replace(':3000', ':4020')
          }
          loggerWS(`Found endpoint for ${bucketId} : ${endpoint}`)

          // connect websocket client to the realtime endpoint
          let socket = new WS(`${endpoint}/primus/?token=${this.tokens.access_token}`)
          socket.connected = false
          socket.bucket = bucketId

          let keepAliveHandler = function () {
            socket.send(`primus::pong::${Date.now()}`)
          }
          let keepAliveInterval = null

          let onConnect = () => {
            logger(`Connected to ws endpoint : ${endpoint} (bucket: ${bucketId})`)
            socket.connected = true
            this.realtime.emit(`${bucket.public_id}:connected`)

            socket.send(JSON.stringify({
              action: 'active',
              public_id: bucket.public_id
            }))

            if (keepAliveInterval !== null) {
              clearInterval(keepAliveInterval)
              keepAliveInterval = null
            }
            keepAliveInterval = setInterval(keepAliveHandler.bind(this), 5000)
          }
          socket.onopen = onConnect
          socket.onreconnect = onConnect

          socket.onerror = (err) => {
            loggerWS(`Error on ${endpoint} (bucket: ${bucketId})`)
            loggerWS(err)

            this.realtime.emit(`${bucket.public_id}:error`, err)
          }

          socket.onclose = () => {
            logger(`Closing ws connection ${endpoint} (bucket: ${bucketId})`)
            socket.connected = false
            this.realtime.emit(`${bucket.public_id}:disconnected`)

            if (keepAliveInterval !== null) {
              clearInterval(keepAliveInterval)
              keepAliveInterval = null
            }
          }

          // broadcast in the bus
          socket.onmessage = (msg) => {
            loggerWS(`Received message for bucket ${bucketId} (${(msg.data.length / 1000).toFixed(1)} Kb)`)
            let data = JSON.parse(msg.data)
            let packet = data.data[1]
            Object.keys(packet).forEach((event) => {
              if (event === 'server_name') return
              this.realtime.emit(`${bucket.public_id}:${data.server_name || 'none'}:${event}`, packet[event])
            })
          }

          this._websockets.push(socket)
          return resolve(socket)
        }).catch(reject)
    })
  }

  /**
   * Unsubscribe realtime from bucket
   * @param {String} bucketId bucket id
   * @param {Object} [opts]
   *
   * @return {Promise}
   */
  unsubscribe (bucketId, opts) {
    return new Promise((resolve, reject) => {
      logger(`Unsubscribe from realtime for ${bucketId}`)
      let socket = this._websockets.find(socket => socket.bucket === bucketId)
      if (!socket) {
        return reject(new Error(`Realtime wasn't connected to ${bucketId}`))
      }
      socket.close(1000, 'Disconnecting')
      logger(`Succesfully unsubscribed from realtime for ${bucketId}`)
      return resolve()
    })
  }
}
