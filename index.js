const R = require('ramda')
// doAction :: async (data, state, amount) => res
const DO_NOTHING = () => {}
const INITIAL_COSTS = 1
const INITIAL_MONEY = 0
const EMPTY_NODE_DATA = Symbol('EMPTY_NODE')
const ERRORS_PROP = Symbol('ERRORS')
const ERROR_TYPE_PROP = Symbol('ERROR_TYPE_PROP')
const ERROR_CATCHER = Symbol('ERROR_CATCHER')
const IS_IMPOSSIBLE = Symbol('IMPOSSIBLE')
const TIMEOUT_TOKEN = Symbol('TIMEOUT_TOKEN')
const ABORTED = Symbol('ABORTED')
const wait = ms => new Promise(res => setTimeout(() => res(TIMEOUT_TOKEN), ms))
const createTimeoutPromise = (timeout, promise) => {
  const resPromise = Promise.race([promise, wait(timeout)])
  .then(res => {
    if (res === TIMEOUT_TOKEN) throw new Error('Timeout was overflowed')
    return res
  })
  return resPromise
}
const getAllErrors = state => state[ERRORS_PROP] || {}

const getError = R.curry((state, id) => {
  const allErrors = getAllErrors(state)
  return R.path([id, 0], allErrors)
})

class Node {
  constructor (id, data, costs = INITIAL_COSTS, initialMoney = 0, getPromiseCatcher = null, maxGive=Infinity) {
    this.id = id
    this.data = data
    this.money = initialMoney
    this.costs = costs
    this.errorChildren = []
    this.children = []
    this.maxGive = maxGive
    this.getPromiseCatcher = getPromiseCatcher
    this[ABORTED] = false
    this.abortedPromise = new Promise((res, rej) => {
      this._abortResolveFunc = res
    })
    this.createPromise()
  }
  isAborted () {
    return this[ABORTED]
  }
  setAborted (value = true) {
    if (value) this._abortResolveFunc(ABORTED)
    this[ABORTED] = value
  }
  setImpossible(value = true) {
    this[IS_IMPOSSIBLE] = value
  }
  
  isImpossible() {
    return this[IS_IMPOSSIBLE]
  }
  
  getPromise() {
    return this.promise
  }
  
  createPromise() {
    const newPromise = new Promise((resolve, reject) => {
          this._resolve = resolve
          this._reject = reject
        })
    if (this.getPromiseCatcher) {
      newPromise.catch((error) => this.getPromiseCatcher()(error))
    }
    this.promise = newPromise
  }
  
  increaseCosts(delta) {
    this.costs += Math.max(0, delta)
  }
  
  getCosts() {
    return this.costs
  }
  
  resolve (...args) {
    this._resolve(...args)
    this.createPromise()
  }
  reject (...args) {
    this._reject(...args)
    this.createPromise()
  }
  
  isEmpty () {
    return this.data === EMPTY_NODE_DATA
  }

  setCatchErrorBy(getFunc) {
    this.getPromiseCatcher = getFunc
  }
  
  addErrorChild (node = Node.EMPTY, costs = 1) {
    if (this.isAborted()) return
    if (this.isEmpty()) return
    this.errorChildren.push({ node, costs })
  }
  
  addChild (node = Node.EMPTY, costs = 1) {
    if (this.isAborted()) return
    if (this.isEmpty()) return
    this.children.push({ node, costs })
  }
  
  async takeMoney (state, money, doAction = DO_NOTHING) {
    if (this.isAborted()) this.reject(new Error('ABORTED'))
    if (this.isEmpty()) {
      this.resolve()
      return
    }
    money = Math.min(money, this.maxGive)
    this.money += money
    if (this.money < this.costs) return
    
    const amount = this.costs !== 0
      ? Math.floor(this.money / this.costs)
      : 1
    let nextNodes = this.children
    try {
      const res = await Promise.race([
        doAction(this.data, state, amount),
        this.abortedPromise
      ])
      if (res === ABORTED) {
        return
      }
      this.resolve(res)
    } catch (error) {
      if (!this.errorChildren.length) {
        this.reject(error)
        return
      }
      state[ERRORS_PROP] = state[ERRORS_PROP] || {}
      state[ERRORS_PROP][this.id] = state[ERRORS_PROP][this.id] || []
      state[ERRORS_PROP][this.id].push(error)
      nextNodes = this.errorChildren
    }
    this.money -= this.costs * amount
    for (const { node, costs } of nextNodes) {
      node.takeMoney(state, costs, doAction)
    }
  }
}
Node.EMPTY = new Node(0, EMPTY_NODE_DATA, () => EMPTY_NODE_DATA, 1, 0)
const createErrorNode = (handler, getErrorPromiseReject) => {
  const res = new Node(-1, {
    [ERROR_TYPE_PROP]: ERROR_CATCHER,
    handler
  }, 1, 0, getErrorPromiseReject)
  return res
}
const doTasks = R.curry(async (
    tasks, 
    {
      getId = (counter => () => counter++)(0),
      getDependencies = () => [],
      getCatchers = ()=>[],
      timeout
    }, 
    doAction
  ) => {  
  const nodes = tasks.map(data => new Node(getId(data), data, 0, 0))
  const nodesById = R.map(R.head, R.groupBy(R.pipe(R.prop('data'), getId), nodes))
  let errorPromiseReject = () => {}
  let errorPromise = new Promise((resolve, reject) => {
    errorPromiseReject = reject
  })
  const _doAction  = async (data, state, amount) => {
    const isErrorData = R.prop(ERROR_TYPE_PROP, data) === ERROR_CATCHER
    try {
      if (isErrorData) {
        const res = await (typeof data.handler === 'function'
          ? data.handler({ data, state, amount, getError })
          : data.handler)
        return res
      }
      await doAction(data, state, amount)
    } catch (err) {
      throw err
    }
  }
  nodes.forEach(node => {
    const dependencies = getDependencies(node.data) || []
    const catchers = getCatchers(node.data)
    dependencies.forEach(id => {
      const parent = nodesById[id]
      if (!parent) {
        node.setImpossible()
        return
      }
      nodesById[id].addChild(node, 1)
      node.increaseCosts(1)
    })
    catchers.forEach(func => {
      const errorNode = createErrorNode(func, () => errorPromiseReject)
      node.addErrorChild(errorNode, 1)
    })
  })
  if (nodes.some(node => node.isImpossible())) {
    throw new Error('Impossible to solve these tasks')
  }
  const nodePromises = Promise.all(nodes.map(node => node.getPromise()))

  const actualTimeout = typeof timeout === 'function'
    ? timeout({ tasks })
    : timeout
  const timeoutPresent = typeof actualTimeout === 'number' && actualTimeout > 0
  const promises = timeoutPresent
    ? createTimeoutPromise(actualTimeout, nodePromises)
    : nodePromises
  const state = {}
  
  try {
    await Promise.all([errorPromise, ...nodes.filter(node => node.getCosts() === 0)
      .map(n => n.takeMoney(state, 1, _doAction))])
    res = await promises

    return {
      res,
      state
    }
  } catch (error) {
    nodes.forEach(node => node.setAborted())
    throw error
  }
  
})
module.export = {
  doTasks, // async (tasks, { getId, getDependencies, getCatchers, timeout}, doAction: function(data, state, amount): *)
  wait 
}

// const tasks = [
//   { id: 0, time: 50, dependencies: [3] },
//   { id: 1, time: 100, dependencies: []},
//   { id: 2, time: 200, dependencies: [0] },
//   { id: 3, time: 400, dependencies: [1] },
//   { id: 4, time: 800, dependencies: [2] },
//   { id: 5, time: 700, dependencies: [2, 3], exception: 'ERROR' }, // comment it
//   { id: 6, time: 700, dependencies: [2, 3]}
// ]
// const getId = R.prop('id')
// const getDependencies = R.prop('dependencies')
// const getCatchers = ({ id }) => [({state, getError })=>{
//   const errors = getError(state, id)
//   console.log('in catcher: ', errors)
//   // throw 'exception'
// }]
// const doAction = async (data, state, amount) => {
//   if (!state.order) state.order = []
//   if (data.exception) {
//     throw new Error(data.exception)
//   }
//   for (let i = 0; i < amount; i++) {
//     await wait(data.time)
//     state.order.push(data.id)
//     console.log(data.id)
//   }
//   return data.id
// }
// async function main() {
//   try {
//     const res = await doTasks(tasks, { getId, getDependencies, getCatchers }, doAction)
//     console.log(res)
//   } catch (err) {
//     console.log('catched ERROR: ', err)
//   }
// }
// console.clear()
// main()// 