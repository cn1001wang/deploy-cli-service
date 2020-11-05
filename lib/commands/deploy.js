const fs = require('fs')
const ora = require('ora')
const inquirer = require('inquirer')
const archiver = require('archiver')
const { NodeSSH } = require('node-ssh')
const childProcess = require('child_process')
const { deployConfigPath } = require('../config')
const {
  checkDeployConfigExists,
  log,
  succeed,
  error,
  underline
} = require('../utils')

const ssh = new NodeSSH()
const maxBuffer = 5000 * 1024
let removeFileCommand = async (dir, config) => {
  await ssh.execCommand(`${config.isWindows ? `DEL /Q /S /F` : 'rm -rf'} ${dir}`)
}

// 任务列表
let taskList

// 是否确认部署
const confirmDeploy = (message) => {
  return inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message
    }
  ])
}

// 检查环境是否正确
const checkEnvCorrect = (config, env) => {
  const keys = [
    'name',
    'script',
    'host',
    'port',
    'username',
    'distPath',
    'webDir'
  ]

  if (
    config &&
    (function () {
      const { privateKey, password } = config
      if (!privateKey && !password) {
        error(
          `配置错误: 请配置 ${underline('privateKey')} 或 ${underline(
            'passwrod'
          )}`
        )
        process.exit(1)
      }
      return true
    })()
  ) {
    keys.forEach((key) => {
      if (!config[key] || config[key] === '/') {
        error(
          `配置错误: ${underline(`${env}环境`)} ${underline(
            `${key}属性`
          )} 配置不正确`
        )
        process.exit(1)
      }
    })
  } else {
    error('配置错误: 未指定部署环境或指定部署环境不存在')
    process.exit(1)
  }
}

// 执行打包脚本
const execBuild = async (config, index) => {
  try {
    const { script } = config
    log(`(${index}) ${script}`)
    const spinner = ora('正在打包中\n')

    spinner.start()

    await new Promise((resolve, reject) => {
      childProcess.exec(
        script,
        { cwd: process.cwd(), maxBuffer: maxBuffer },
        (e) => {
          spinner.stop()
          if (e === null) {
            succeed('打包成功')
            resolve()
          } else {
            reject(e.message)
          }
        }
      )
    })
  } catch (e) {
    error('打包失败')
    error(e)
    process.exit(1)
  }
}

// 打包Zip
const buildZip = async (config, index) => {
  await new Promise((resolve, reject) => {
    log(`(${index}) 打包 ${underline(config.distPath)} Zip`)
    const archive = archiver('zip', {
      zlib: { level: 9 }
    }).on('error', (e) => {
      error(e)
    })

    const output = fs
      .createWriteStream(`${process.cwd()}/${config.distPath}.zip`)
      .on('close', (e) => {
        if (e) {
          error(`打包zip出错: ${e}`)
          reject(e)
          process.exit(1)
        } else {
          succeed(`${underline(`${config.distPath}.zip`)} 打包成功`)
          resolve()
        }
      })

    archive.pipe(output)
    archive.directory(config.distPath, false)
    archive.finalize()
  })
}

// 连接ssh
const connectSSH = async (config, index) => {
  try {
    log(`(${index}) ssh连接 ${underline(config.host)}`)
    await ssh.connect(config)
    succeed('ssh连接成功')
  } catch (e) {
    error(e)
    process.exit(1)
  }
}

// 上传本地文件
const uploadLocalFile = async (config, index) => {
  try {
    const localFileName = `${config.distPath}.zip`
    const localPath = `${process.cwd()}/${localFileName}`

    let webDir = config.webDir
    if (!Array.isArray(webDir)) webDir = [config.webDir]

    let remoteFileNames = webDir.map((el) => `${el}.zip`)

    log(`(${index}) 上传打包zip至目录 ${underline(remoteFileNames.toString())}`)

    const spinner = ora('正在上传中\n')

    spinner.start()

    let files = remoteFileNames.map((remoteFileName) => ({
      local: localPath,
      remote: remoteFileName
    }))
    await ssh.putFiles(files, {
      concurrency: 10
    })

    spinner.stop()
    succeed('上传成功')
  } catch (e) {
    error(`上传失败: ${e}`)
    process.exit(1)
  }
}

// 删除远程文件
const removeRemoteFile = async (config, index) => {
  try {
    let webDir = config.webDir
    if (!Array.isArray(webDir)) webDir = [config.webDir]

    log(`(${index}) 删除远程文件 ${underline(webDir.toString())}`)
    for (let i = 0; i < webDir.length; i++) {
      await removeFileCommand(webDir[i], config)
    }

    succeed('删除成功')
  } catch (e) {
    error(e)
    process.exit(1)
  }
}
// `xcopy C:\WebSite\Master\Tool\update\wwwroot\PC C:\WebSite\Master\Cluster\Background\wwwroot\PC /S`

// 解压远程文件
const unzipRemoteFile = async (config, index) => {
  try {
    let webDir = config.webDir
    if (!Array.isArray(webDir)) webDir = [config.webDir]

    log(
      `(${index}) 解压远程文件 ${underline(
        webDir.map((el) => `${el}.zip`).toString()
      )}`
    )
    for (let i = 0; i < webDir.length; i++) {
      let remoteDir = webDir[i]
      await ssh.execCommand(`unzip -o ${remoteDir}.zip -d ${remoteDir}`)
      await removeFileCommand(`${remoteDir}.zip`, config)
    }

    succeed('解压成功')
  } catch (e) {
    error(e)
    process.exit(1)
  }
}

// 删除本地打包文件
const removeLocalFile = (config, index) => {
  const localPath = `${process.cwd()}/${config.distPath}`

  log(`(${index}) 删除本地打包目录 ${underline(localPath)}`)

  const remove = (path) => {
    if (fs.existsSync(path)) {
      fs.readdirSync(path).forEach((file) => {
        let currentPath = `${path}/${file}`
        if (fs.statSync(currentPath).isDirectory()) {
          remove(currentPath)
        } else {
          fs.unlinkSync(currentPath)
        }
      })
      fs.rmdirSync(path)
    }
  }

  remove(localPath)
  fs.unlinkSync(`${localPath}.zip`)
  succeed('删除本地打包目录成功')
}

// 断开ssh
const disconnectSSH = () => {
  ssh.dispose()
}

// 创建任务列表
const createTaskList = (config) => {
  const { isRemoveRemoteFile = true } = config

  taskList = []
  taskList.push(execBuild)
  taskList.push(buildZip)
  taskList.push(connectSSH)
  taskList.push(uploadLocalFile)
  isRemoveRemoteFile && taskList.push(removeRemoteFile)
  taskList.push(unzipRemoteFile)
  taskList.push(removeLocalFile)
  taskList.push(disconnectSSH)
}

// 执行任务列表
const executeTaskList = async (config) => {
  for (const [index, execute] of new Map(
    taskList.map((execute, index) => [index, execute])
  )) {
    await execute(config, index + 1)
  }
}

module.exports = {
  description: '部署项目',
  apply: async (env) => {
    if (checkDeployConfigExists()) {
      const config = require(deployConfigPath)
      const projectName = config.projectName
      const envConfig = Object.assign(config[env], {
        privateKey: config.privateKey,
        passphrase: config.passphrase
      })

      checkEnvCorrect(envConfig, env)

      const answers = await confirmDeploy(
        `${underline(projectName)} 项目是否部署到 ${underline(envConfig.name)}?`
      )

      if (answers.confirm) {
        createTaskList(envConfig)

        await executeTaskList(envConfig)

        succeed(
          `恭喜您，${underline(projectName)}项目已在${underline(
            envConfig.name
          )}部署成功\n`
        )
        process.exit(0)
      } else {
        process.exit(1)
      }
    } else {
      error(
        'deploy.config.js 文件不存，请使用 deploy-cli-service init 命令创建'
      )
      process.exit(1)
    }
  }
}
