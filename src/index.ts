/* eslint-disable no-console */
import { type Boom } from '@hapi/boom'
import makeWASocket, {
  DisconnectReason,
  type GroupMetadata,
  type proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import dotenv from 'dotenv'

dotenv.config()

let sock: ReturnType<typeof makeWASocket>

function getGroupSubjectFromMessage(message: proto.IWebMessageInfo) {
  const chatDisplayName =
    message.pushName ??
    message.message?.chat?.displayName ??
    message.key.participant ??
    message.key.remoteJid ??
    ''

  const redirectGroupPrefix = '🔄 '

  return `${redirectGroupPrefix} ${chatDisplayName}`
}

async function getGroupFromSubject(subject: string): Promise<GroupMetadata | null> {
  const result = await sock.groupFetchAllParticipating()
  const groups = Object.values(result)

  return groups.find((group) => group.subject === subject) ?? null
}

async function getGroupFromMessage(message: proto.IWebMessageInfo): Promise<GroupMetadata | null> {
  const groupJid = message.key.remoteJid ?? ''

  const group = await sock.groupMetadata(groupJid)

  return group
}

async function createGroup(groupName: string): Promise<GroupMetadata> {
  const redirectNumber = process.env.REDIRECT_NUMBER
  const redirectNumberJid = `${redirectNumber ?? ''}@s.whatsapp.net`

  const group = await sock.groupCreate(groupName, [redirectNumberJid])

  return group
}

async function redirectMessage(message: proto.IWebMessageInfo) {
  const groupSubject = getGroupSubjectFromMessage(message)
  let redirectGroup = await getGroupFromSubject(groupSubject)

  if (!redirectGroup) {
    redirectGroup = await createGroup(groupSubject)

    await sock.groupUpdateDescription(redirectGroup.id, message.key.remoteJid ?? '')
  }

  await sock.sendMessage(redirectGroup.id, { forward: message })
}

async function sendMessageFromRedirectGroup(message: proto.IWebMessageInfo) {
  const redirectGroup = await getGroupFromMessage(message)
  const isForwarded = Boolean(message.message?.extendedTextMessage?.contextInfo?.isForwarded)

  if (redirectGroup && !isForwarded && message.message && message.key.id) {
    const sourceChatJid = redirectGroup.desc ?? ''

    await sock.relayMessage(sourceChatJid, message.message, { messageId: message.key.id })
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

  sock = makeWASocket({
    // can provide additional config here
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update

    if (connection === 'close') {
      const shouldReconnect =
        ((lastDisconnect?.error as Boom).output.statusCode as DisconnectReason) !==
        DisconnectReason.loggedOut

      console.log(
        'connection closed due to ',
        lastDisconnect?.error,
        ', reconnecting ',
        shouldReconnect,
      )

      // reconnect if not logged out
      if (shouldReconnect) {
        await connectToWhatsApp()
      }
    } else if (connection === 'open') {
      console.log('opened connection')
    }
  })
  sock.ev.on('messages.upsert', (event) => {
    for (const message of event.messages) {
      if (!message.message) {
        continue
      }

      if (message.key.remoteJid && !message.key.fromMe) {
        redirectMessage(message)
      }

      if (message.key.remoteJid && message.key.fromMe) {
        sendMessageFromRedirectGroup(message)
      }
    }
  })

  // to storage creds (session info) when it updates
  sock.ev.on('creds.update', saveCreds)
}

// run in main file
connectToWhatsApp()
