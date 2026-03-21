// Redis based job queue using BullMQ

const { Queue } = require('bullmq')
const IORedis = require('ioredis')

const connection = new IORedis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
  maxRetriesPerRequest: null,
})

const deployQueue = new Queue('deployments', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 3000 },
    timeout: 300000, // 5 min per attempt
    removeOnComplete: { count: 200 },
    removeOnFail: false, // keep failed jobs for DLQ inspection
  },
})

async function addDeploymentJob(agent){
  await deployQueue.add('deploy-agent', agent)
}

/** Retrieve failed jobs (dead letter queue) for inspection. */
async function getDLQJobs(start = 0, end = 50) {
  return deployQueue.getFailed(start, end)
}

/** Retry a specific failed job by its ID. */
async function retryDLQJob(jobId) {
  const job = await deployQueue.getJob(jobId)
  if (!job) throw new Error(`Job ${jobId} not found`)
  await job.retry()
  return { jobId, status: 'retried' }
}

module.exports = { deployQueue, addDeploymentJob, getDLQJobs, retryDLQJob, connection }
