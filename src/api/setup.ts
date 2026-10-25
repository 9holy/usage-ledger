/**
 * Setup API endpoints
 */
import axios from 'axios'
import type { SetupEnvironment } from '@/features/desktop/setupEnvironment'
import { buildGatewayUrl } from './url'
import { isDesktopRuntime } from './url'

// Create a separate client for setup endpoints (not under /api/v1)
const setupClient = axios.create({
  baseURL: buildGatewayUrl('/').replace(/\/+$/, ''),
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

export interface SetupStatus {
  needs_setup: boolean
  step: string
}

export interface DatabaseConfig {
  host: string
  port: number
  user: string
  password: string
  dbname: string
  sslmode: string
}

export interface RedisConfig {
  host: string
  port: number
  username: string
  password: string
  db: number
  enable_tls: boolean
}

export interface AdminConfig {
  email: string
  password: string
}

export interface ServerConfig {
  host: string
  port: number
  mode: string
}

export interface InstallRequest {
  database: DatabaseConfig
  redis: RedisConfig
  admin: AdminConfig
  server: ServerConfig
}

export interface InstallResponse {
  message: string
  restart: boolean
}

export interface ManagedSetupConfig {
  database: DatabaseConfig
  redis: RedisConfig
  postgres_image: string
  valkey_image: string
}

export interface SetupProvisionProgress {
  stage: string
  message: string
  percent: number
}

export async function detectSetupEnvironment(): Promise<SetupEnvironment> {
  // 远程模式无内置 sub2api 后端,本地不再探测 Docker/PG/Redis(原 Tauri 命令 detect_setup_environment 已随 sidecar 删除)。
  // 统一返回不可用结构,SetupWizardView 据此引导用户连接远程实例而非本地安装。
  const unavailable = (port: number) => ({
    host: '127.0.0.1',
    port,
    reachable: false,
  })
  return {
    desktop: isDesktopRuntime(),
    docker: {
      installed: false,
      running: false,
      version: '',
      message: '远程连接模式下无需本地环境探测,请在连接页配置远程 Sub2API / CLI Proxy API。',
    },
    postgres: unavailable(5432),
    redis: unavailable(6379),
    managed_postgres: unavailable(15432),
    managed_redis: unavailable(16379),
  }
}

export async function provisionQuickSetup(): Promise<ManagedSetupConfig> {
  // 远程模式无内置后端,不再本地拉起 PG/Redis(原 Tauri 命令 provision_quick_setup 已随 sidecar 删除)。
  throw new Error('远程连接模式下不支持本地快速安装,请在连接页配置远程 Sub2API 实例。')
}

/**
 * Get setup status
 */
export async function getSetupStatus(): Promise<SetupStatus> {
  const response = await setupClient.get('/setup/status')
  return response.data.data
}

/**
 * Test database connection
 */
export async function testDatabase(config: DatabaseConfig): Promise<void> {
  await setupClient.post('/setup/test-db', config)
}

/**
 * Test Redis connection
 */
export async function testRedis(config: RedisConfig): Promise<void> {
  await setupClient.post('/setup/test-redis', config)
}

/**
 * Perform installation
 */
export async function install(config: InstallRequest): Promise<InstallResponse> {
  const response = await setupClient.post('/setup/install', config)
  return response.data.data
}
