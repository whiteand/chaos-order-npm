const r = require('./index.js')

const tasks = [
  { name: 'wedding', dep: ['money-for-wedding', 'worker', 'house', 'with bride'], duration: 100},
  { name: 'money-for-wedding', dep: ['worker', 'house'], duration: 1000},
  { name: 'worker', dep: ['findWork'], duration: 0 },
  { name: 'house', dep: ['money-for-house'], duration: 100 },
  { name: 'money-for-house', dep: ['worker'], duration: 2000 },
  { name: 'findWork', dep: [], duration: 200 },
  { name: 'with bride', dep: ['find bride'], duration: 0},
  { name: 'find bride', dep: [], duration: 1000},
]
async function main() {
  try {
    await r.doTasks(
      tasks,
      {
        getId: x => x.name,
        getDependencies: x => x.dep
      },
      async ({name, duration}) => {
        console.log(`start: ${name}`)
        await r.wait(duration)
        console.log(`done: ${name}`)
      }
    )
  } catch (error) {
    console.log(error)
  }
}
main()