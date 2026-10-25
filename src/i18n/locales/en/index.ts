import landing from './landing'
import common from './common'
import dashboard from './dashboard'
import channelMonitorV2 from './channelMonitorV2'
import batchImage from './batchImage'
import admin from './admin'
import misc from './misc'
import cliproxy from './cliproxy'
import desktop from './desktop'
import usageMonitor from './usageMonitor'
import costComponents from './costComponents'
import costData from './costData'
import costCenter from './costCenter'

export default {
  ...landing,
  ...common,
  ...dashboard,
  ...channelMonitorV2,
  ...batchImage,
  admin,
  ...cliproxy,
  desktop,
  usageMonitor,
  ...costComponents,
  costData,
  costCenter,
  ...misc,
}
