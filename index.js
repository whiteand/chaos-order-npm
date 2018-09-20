const R = require('ramda')

const ORDER_TYPES = {
  EMPTY: 'EMPTY',
  ONE_ACTION: 'ONE_ACTION',
  SEQUENCE: 'SEQUENCE',
  PARALLEL: 'PARALLEL'
}

const getEmpty = () => ({ type: ORDER_TYPES.EMPTY })
const getOneAction = task => ({ type: ORDER_TYPES.ONE_ACTION, task })
const colorPropName = Symbol('COLOR')
const getSequence = (...scenarios) => {
  const innerScenarios = scenarios.reduce((res, s) => {
    switch (s.type) {
      case ORDER_TYPES.EMPTY:
        return res
      case ORDER_TYPES.ONE_ACTION:
      case ORDER_TYPES.PARALLEL:
        return [...res, s]
      case ORDER_TYPES.SEQUENCE:
        return [...res, ...s.scenarios]
    }
  }, [])
  switch (innerScenarios.length) {
    case 0: return getEmpty()
    case 1: return R.head(innerScenarios)
    default: return {
      type: ORDER_TYPES.SEQUENCE,
      scenarios: innerScenarios
    }
  }
}

const getParallel = (...scenarios) => {
 const innerScenarios = scenarios.reduce((res, s) => {
    switch (s.type) {
      case ORDER_TYPES.EMPTY:
        return res
      case ORDER_TYPES.ONE_ACTION:
      case ORDER_TYPES.SEQUENCE:
        return [...res, s]
      case ORDER_TYPES.PARALLEL:
        return [...res, ...s.scenarios]
    }
    throw s
  }, [])
  switch (innerScenarios.length) {
    case 0:
      return getEmpty()
    case 1:
      return R.head(innerScenarios)
    default:
      return {
        type: ORDER_TYPES.PARALLEL,
        scenarios: innerScenarios
      }
  } 
}

const componentToScenario = R.curry((isDone, component) => {
  let lastTrees       = component
  const sequence      = [],
        isIndependent = R.pipe(
          R.pathOr([], ['before']),
          R.all(id => isDone[id])
        )
  while (lastTrees.length > 0) {
    const [heads, tails] = R.partition(isIndependent, lastTrees)
    if (heads.length === 0) {
      throw 'Something wrong'
    }
    const parallel = getParallel(
      ...heads.map(({ data }) => getOneAction(data))
    )
    sequence.push(parallel)
    heads.forEach(({id}) => {
      isDone[id] = true
    })
    lastTrees = tails
  }
  return getSequence(...sequence)
})

class Forest {
  constructor () {
    this.trees = []
    this._dict = []
  }

  getTreeById (id) {
    return R.path([id], this._dict)
  }

  get treeIds () {
    return Object.keys(this._dict)
  }

  appendTree (tree) {
    if (this._dict[tree.id]) {
      this._dict[tree.id] = tree
      this.trees = this.trees.map(t => t.id === tree.id ? tree : t)
      return
    }
    this.trees.push(tree)
    this._dict[tree.id] = tree
    tree.before.forEach(id => {
      this._dict[id].after.push(tree.id)
    })
    tree.after.forEach(id => {
      this._dict[id].before.push(tree.id)
    })
    return this
  }

  appendTrees (trees) {
    let needToBeAdded = trees
    const isReady = R.pipe(
      R.pathOr([], ['before']),
      R.all(id => this._dict[id])
    )
    while (needToBeAdded.length > 0) {
      const [ready, notReady] = R.partition(
        isReady,
        needToBeAdded
      )
      if (R.isEmpty(ready)) {
        const notReadyIds = R.pluck('id', notReadyIds)
        throw new Error(`Unresolved ${notReadyIds.join(', ')}`)
      }
      ready.forEach(t => this.appendTree(t))
      needToBeAdded = notReady
    }
    return this
  }

  get getComponents () {
    let color = 0
    const getColor          = R.prop(colorPropName)
    const isColored         = R.pipe(getColor, R.complement(R.isNil))
    const notColored        = R.complement(isColored)
    const setColor          = R.curry((color, tree) => {
      tree[colorPropName] = color 
    })
    const colorAllNeighbors = R.curry((color, tree) => {
      if (isColored(tree)) return
      setColor(color, tree)
      const idsToBeColored = [...tree.after, ...tree.before]
      idsToBeColored.map(id => this.getTreeById(id))
        .forEach(t => colorAllNeighbors(color, t))
    })

    while (true) {
      const firstNotColored = this.trees.find(notColored)
      if (!firstNotColored) break;
      colorAllNeighbors(color, firstNotColored)
      color++
    }

    let components = []
    for (let c = 0; c < color; c++) {
      const treesInComponent = this.trees.filter(
        R.pipe(
          getColor,
          R.equals(c)
        )
      ).map(R.omit(colorPropName))

      components.push(treesInComponent)
    }
    return components
  }

  get toScenario () {
    const isDone = {}
    const ids = this.treeIds
    switch (ids.length) {
      case 0:
        return getEmpty()
      case 1:
        const tree = R.head(this.trees)
        return getOneAction(tree.data)
    }

    const components = this.getComponents
    if (R.isEmpty(components)) return getEmpty()
    if (components.length === 1) {
      const [component] = components
      return componentToScenario(isDone, component)
    }
    const parallel = components.map(componentToScenario(isDone))
    return getParallel(...parallel)
  }
}

class Tree {
  constructor(id = undefined['id required'], data = null) {
    this.id = id
    this.data = data
    this.before = []
    this.after = []
  }
  setBefore(newBefore) {
    this.before = newBefore
  }
}

const counter = (currentValue => () => {
  return currentValue++
})(0)

const defaultToId = task => {
  if (typeof task.toId === 'function') return task.toId()
  return R.path(['id'], task) || `id_${counter()}`
}

const defaultGetDependencyIds = task => {
  return R.pathOr([], ['dependencies'], task)
}

const taskToTree = R.curry((toId, getDependencyIds, task) => {
  const tree = new Tree(toId(task), task)
  const dependecyIds = getDependencyIds(task)
  tree.setBefore(dependecyIds)
  return tree
})

const getScenario = R.curry((callbacks, tasks) => {
  try {
    const {
      toId = defaultToId,
      getDependencyIds = defaultGetDependencyIds
    } = callbacks
    const trees = tasks.map(taskToTree(toId, getDependencyIds))
    
    const forest = new Forest().appendTrees(trees)
    const scenario = forest.toScenario
    return scenario
  } catch (error) {
    throw error
  }
})

const toSchema = scenario => {
  const braces = {
    [ORDER_TYPES.EMPTY]: str => str,
    [ORDER_TYPES.ONE_ACTION]: str => str,
    [ORDER_TYPES.SEQUENCE]: str => `(${str})`,
    [ORDER_TYPES.PARALLEL]: str => `[${str}]`
  }
  const getText = {
    [ORDER_TYPES.EMPTY]: s => '',
    [ORDER_TYPES.ONE_ACTION]: s => s.task.id,
    [ORDER_TYPES.SEQUENCE]: s => s.scenarios.map(toSchema).join(', '),
    [ORDER_TYPES.PARALLEL]: s => s.scenarios.map(toSchema).join(', ')
  }
  const t = scenario.type
  return braces[t](getText[t](scenario))
}

async function doScenario (getPromiseFromTask, scenario) {
  try {
    switch (scenario.type) {
      case ORDER_TYPES.EMPTY:
        return
      case ORDER_TYPES.ONE_ACTION:
        return await getPromiseFromTask(scenario.task)
      case ORDER_TYPES.SEQUENCE:
        return await scenario.scenarios.reduce((previous, cur)=>{
          return previous.then(() => doScenarioAsync(getPromiseFromTask, cur))
        }, Promise.resolve())
      case ORDER_TYPES.PARALLEL:
        return await Promise.all(
          scenario.scenarios.map(sc => doScenarioAsync(getPromiseFromTask, sc))
        )
    }
  } catch (error) {
    throw error
  }
  return 'Something'
}

function doScenarioSync (doAction, scenario) {
  try {
    switch (scenario.type) {
      case ORDER_TYPES.EMPTY:
        return
      case ORDER_TYPES.ONE_ACTION:
        return doAction(scenario.task)
      case ORDER_TYPES.SEQUENCE:
      case ORDER_TYPES.PARALLEL:
        scenario.scenarios.forEach(doAction)
    }
  } catch (error) {
    throw error
  }
}

module.exports = {
  ORDER_TYPES,
  getScenario,
  toSchema,
  doScenario,
  doScenarioSync
}