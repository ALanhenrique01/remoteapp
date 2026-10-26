const config = require('./package.json').build
const updateUrl = process.env.SUPPORT_UPDATE_URL?.trim() || 'http://10.1.1.212:8787/updates/'

const parsedUrl = new URL(updateUrl)
const isLanTestFeed = parsedUrl.protocol === 'http:' && parsedUrl.hostname === '10.1.1.212'
if (parsedUrl.protocol !== 'https:' && !isLanTestFeed) {
  throw new Error('SUPPORT_UPDATE_URL precisa usar HTTPS, exceto no IP de teste 10.1.1.212.')
}
config.publish = [{ provider: 'generic', url: parsedUrl.toString() }]

module.exports = config