import Telegraf, { ContextMessageUpdate, Extra, Markup } from 'telegraf'
import { strings } from './strings'
import {
  Candidate,
  findChatsWithCandidates,
  CaptchaType,
  Equation,
  removeMessages,
  Chat,
  isVerifiedUser,
  addVerifiedUser,
} from '../models'
import { bot } from './bot'
import { User, Message } from 'telegram-typings'
import { report } from './report'
import { ExtraReplyMessage } from 'telegraf/typings/telegram-types'
import { generateEquation } from './equation'
import { checkCAS } from './cas'
import { getImageCaptcha } from './captcha'
import { checkIfGroup } from '../middlewares/checkIfGroup'
import { modifyGloballyRestricted } from './globallyRestricted'
import { sendHelp } from '../commands/help'
import { modifyCandidates } from './candidates'
import { InstanceType } from 'typegoose'
import { modifyRestrictedUsers } from './restrictedUsers'
import { getUsername, getName, getLink } from './getUsername'
import { cloneDeep, isFunction } from 'lodash'
import { checkSuperAdmin } from '../middlewares/checkSuperAdmin'
import { constructMessageWithEntities } from './constructMessageWithEntities'

const kickedIds = {} as { [index: number]: number[] }
const buttonPresses = {} as { [index: string]: boolean }

const todorantAddition =
  'Powered by <a href="https://todorant.com/?ref=shieldy">Todorant</a>'
const todorantExceptions = [-1001007166727]

export function setupNewcomers(bot: Telegraf<ContextMessageUpdate>) {
  bot.command('greetMe', checkSuperAdmin, greetUser)
  bot.on('new_chat_members', checkIfGroup, onNewChatMembers)
  // Check left messages
  bot.on('left_chat_member', async (ctx) => {
    // Delete left message if required
    if (
      ctx.dbchat.deleteEntryMessages ||
      ctx.dbchat.underAttack ||
      (ctx.dbchat.deleteEntryOnKick &&
        kickedIds[ctx.dbchat.id].includes(ctx.message.left_chat_member.id))
    ) {
      try {
        await ctx.deleteMessage()
      } catch (err) {
        await report(err)
      }
    }
    if (ctx.dbchat.deleteEntryOnKick) {
      let needsSaving = false
      for (const candidate of ctx.dbchat.candidates) {
        if (candidate.id === ctx.message.left_chat_member.id) {
          candidate.leaveMessageId = ctx.message.message_id
          needsSaving = true
        }
      }
      if (needsSaving) {
        await ctx.dbchat.save()
      }
    }
  })
  // Check newcomers
  bot.use(async (ctx, next) => {
    // Check if it the message is from a candidates with text
    if (
      !ctx.message ||
      !ctx.message.text ||
      !ctx.dbchat.candidates.length ||
      !ctx.dbchat.candidates.map((c) => c.id).includes(ctx.from.id)
    ) {
      return next()
    }
    // Check if it is a button captcha (shouldn't get to this function then)
    if (ctx.dbchat.captchaType === CaptchaType.BUTTON) {
      // Delete message of restricted
      if (ctx.dbchat.strict) {
        try {
          await ctx.deleteMessage()
        } catch (err) {
          report(err, 'deleteMessage on button captcha')
        }
      }
      // Exit the function
      return next()
    }
    // Get candidate
    const candidate = ctx.dbchat.candidates
      .filter((c) => c.id === ctx.from.id)
      .pop()
    // Check if it is digits captcha
    if (candidate.captchaType === CaptchaType.DIGITS) {
      // Check the format
      const hasCorrectAnswer = ctx.message.text.includes(
        candidate.equation.answer as string
      )
      const hasNoMoreThanTwoDigits =
        (ctx.message.text.match(/\d/g) || []).length <= 2
      if (!hasCorrectAnswer || !hasNoMoreThanTwoDigits) {
        if (ctx.dbchat.strict) {
          try {
            await ctx.deleteMessage()
          } catch (err) {
            await report(err, 'deleteMessage on digits captcha')
          }
        }
        return next()
      }
      // Delete message to decrease the amount of messages left
      try {
        await ctx.deleteMessage()
      } catch (err) {
        report(err, 'deleteMessage on passed digits captcha')
      }
    }
    // Check if it is image captcha
    if (candidate.captchaType === CaptchaType.IMAGE) {
      const hasCorrectAnswer = ctx.message.text.includes(candidate.imageText)
      if (!hasCorrectAnswer) {
        if (ctx.dbchat.strict) {
          try {
            await ctx.deleteMessage()
          } catch (err) {
            await report(err, 'deleteMessage on image captcha')
          }
        }
        return next()
      }
      // Delete message to decrease the amount of messages left
      try {
        await ctx.deleteMessage()
      } catch (err) {
        report(err, 'deleteMessage on passed image captcha')
      }
    }
    // Passed the captcha, delete from candidates
    await modifyCandidates(ctx.dbchat, false, [candidate])
    // Delete the captcha message
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, candidate.messageId)
    } catch (err) {
      await report(err, 'deleteCaptchaMessage after captcha is passed')
    }
    // Greet user
    await greetUser(ctx)
    console.log(
      'greeted a user',
      ctx.dbchat.captchaType,
      ctx.dbchat.customCaptchaMessage,
      ctx.dbchat.greetsUsers
    )
    if (
      candidate.captchaType === CaptchaType.DIGITS ||
      candidate.captchaType === CaptchaType.IMAGE
    ) {
      await addVerifiedUser(ctx.from.id)
    }
    return next()
  })
  // Check button
  bot.action(/\d+~\d+/, async (ctx) => {
    if (buttonPresses[ctx.callbackQuery.data]) {
      return
    }
    buttonPresses[ctx.callbackQuery.data] = true
    try {
      // Get user id and chat id
      const params = ctx.callbackQuery.data.split('~')
      const userId = parseInt(params[1])
      // Check if button is pressed by the candidate
      if (userId !== ctx.from.id) {
        try {
          await ctx.answerCbQuery(
            strings(ctx.dbchat, 'only_candidate_can_reply')
          )
        } catch (err) {
          await report(err)
        }
        return
      }
      // Check if this user is within candidates
      if (!ctx.dbchat.candidates.map((c) => c.id).includes(userId)) {
        return
      }
      // Get the candidate
      const candidate = ctx.dbchat.candidates
        .filter((c) => c.id === userId)
        .pop()
      // Remove candidate from the chat
      await modifyCandidates(ctx.dbchat, false, [candidate])
      // Delete the captcha message
      try {
        await ctx.telegram.deleteMessage(ctx.chat!.id, candidate.messageId)
      } catch (err) {
        await report(err)
      }
      // Greet the user
      await greetUser(ctx)
      console.log(
        'greeted a user',
        ctx.dbchat.captchaType,
        ctx.dbchat.customCaptchaMessage,
        ctx.dbchat.greetsUsers
      )
    } finally {
      buttonPresses[ctx.callbackQuery.data] = undefined
    }
  })
}

async function onNewChatMembers(ctx: ContextMessageUpdate) {
  // Get list of ids
  const memberIds = ctx.message.new_chat_members.map((m) => m.id)
  // Add to globaly restricted list
  await modifyGloballyRestricted(true, memberIds)
  // Check if needs to delete message right away
  if (ctx.dbchat.deleteEntryMessages || ctx.dbchat.underAttack) {
    try {
      await ctx.deleteMessage()
    } catch {
      // Do nothing
    }
  }
  // Start the newcomers logic
  try {
    // Check if no attack mode
    if (ctx.dbchat.noAttack) {
      return
    }
    // Get admin ids
    const adminIds = (await ctx.getChatAdministrators()).map((u) => u.user.id)
    // If an admin adds the members, do nothing
    if (adminIds.includes(ctx.message.from.id)) {
      return
    }
    // Send help message if added this bot to the group
    const addedUsernames = ctx.message.new_chat_members
      .map((member) => member.username)
      .filter((username) => !!username)
    if (addedUsernames.includes(bot.options.username)) {
      try {
        await sendHelp(ctx)
      } catch (err) {
        report(err)
      }
    }
    // Filter new members
    const membersToCheck = ctx.message.new_chat_members.filter(
      (m) => !adminIds.includes(m.id) && !m.is_bot
    )
    // Kick bots if required
    if (!ctx.dbchat.allowInvitingBots) {
      ctx.message.new_chat_members
        .filter((m) => m.is_bot)
        .forEach((m) => {
          kickChatMember(ctx.dbchat, m)
        })
    }
    // Placeholder to add all candidates in batch
    const candidatesToAdd = [] as Candidate[]
    // Loop through the members
    for (const member of membersToCheck) {
      // Check if an old user
      if (ctx.dbchat.skipOldUsers) {
        if (member.id > 0 && member.id < 1000000000) {
          await greetUser(ctx, member)
          console.log(
            'greeted a user',
            ctx.dbchat.captchaType,
            ctx.dbchat.customCaptchaMessage,
            ctx.dbchat.greetsUsers
          )
          if (ctx.dbchat.restrict) {
            await modifyRestrictedUsers(ctx.dbchat, true, [member])
          }
          continue
        }
      }
      // Check if a verified user
      if (ctx.dbchat.skipVerifiedUsers) {
        if (await isVerifiedUser(member.id)) {
          await greetUser(ctx, member)
          console.log(
            'greeted a user',
            ctx.dbchat.captchaType,
            ctx.dbchat.customCaptchaMessage,
            ctx.dbchat.greetsUsers
          )
          if (ctx.dbchat.restrict) {
            await modifyRestrictedUsers(ctx.dbchat, true, [member])
          }
          continue
        }
      }
      // Delete all messages that they've sent so far
      removeMessages(ctx.chat.id, member.id) // don't await here
      // Check if under attack
      if (ctx.dbchat.underAttack) {
        await kickChatMember(ctx.dbchat, member)
        continue
      }
      // Check if CAS banned
      if (!(await checkCAS(member.id))) {
        if (ctx.dbchat.deleteEntryOnKick) {
          try {
            await ctx.deleteMessage()
          } catch {
            // Do nothing
          }
        }
        await kickChatMember(ctx.dbchat, member)
        continue
      }
      // Check if already a candidate
      if (ctx.dbchat.candidates.map((c) => c.id).includes(member.id)) {
        continue
      }
      // Generate captcha if required
      const { equation, image } = await generateEquationOrImage(ctx.dbchat)
      // Notify candidate and save the message
      let message
      try {
        message = await notifyCandidate(ctx, member, equation, image)
        console.log(
          'notified a user',
          ctx.dbchat.captchaType,
          ctx.dbchat.customCaptchaMessage,
          ctx.dbchat.greetsUsers
        )
      } catch (err) {
        await report(err)
      }
      // Create a candidate
      const candidate = getCandidate(ctx, member, message, equation, image)
      // Restrict candidate if required
      if (ctx.dbchat.restrict) {
        await restrictChatMember(ctx.dbchat, member)
      }
      // Save candidate to the placeholder list
      candidatesToAdd.push(candidate)
    }
    // Add candidates to the list
    await modifyCandidates(ctx.dbchat, true, candidatesToAdd)
    // Restrict candidates if required
    await modifyRestrictedUsers(ctx.dbchat, true, candidatesToAdd)
  } catch (err) {
    console.error('onNewChatMembers', err)
  } finally {
    // Remove from globaly restricted list
    await modifyGloballyRestricted(false, memberIds)
  }
}

async function kickChatMember(chat: InstanceType<Chat>, user: User) {
  // Try kicking the member
  try {
    addKickedUser(chat, user.id)
    await bot.telegram.kickChatMember(
      chat.id,
      user.id,
      chat.banUsers ? 0 : parseInt(`${new Date().getTime() / 1000 + 45}`)
    )
  } catch (err) {
    report(err)
  }
  // Remove from candidates
  await modifyCandidates(chat, false, [user])
  // Remove from restricted
  await modifyRestrictedUsers(chat, false, [user])
}

async function kickCandidates(
  chat: InstanceType<Chat>,
  candidates: Candidate[]
) {
  // Loop through candidates
  for (const candidate of candidates) {
    // Try kicking the candidate
    try {
      addKickedUser(chat, candidate.id)
      kickChatMemberProxy(
        chat.id,
        candidate.id,
        chat.banUsers ? 0 : parseInt(`${new Date().getTime() / 1000 + 45}`)
      )
    } catch (err) {
      report(err)
    }
    // Try deleting their entry messages
    if (chat.deleteEntryOnKick) {
      deleteMessageProxy(candidate.entryChatId, candidate.entryMessageId)
      deleteMessageProxy(candidate.entryChatId, candidate.leaveMessageId)
    }
    // Try deleting the captcha message
    try {
      await bot.telegram.deleteMessage(chat.id, candidate.messageId)
    } catch (err) {
      await report(err, 'deleteMessage')
    }
  }
  // Remove from candidates
  await modifyCandidates(chat, false, candidates)
  // Remove from restricted
  await modifyRestrictedUsers(chat, false, candidates)
}

async function kickChatMemberProxy(
  id: number,
  candidateId: number,
  duration: number
) {
  try {
    await bot.telegram.kickChatMember(id, candidateId, duration)
  } catch (err) {
    report(err)
  }
}

async function deleteMessageProxy(id, messageId) {
  try {
    await bot.telegram.deleteMessage(id, messageId)
  } catch (err) {
    // do nothing
  }
}

async function restrictChatMember(chat: InstanceType<Chat>, user: User) {
  try {
    const gotUser = (await bot.telegram.getChatMember(chat.id, user.id)) as any
    if (
      gotUser.can_send_messages &&
      gotUser.can_send_media_messages &&
      gotUser.can_send_other_messages &&
      gotUser.can_add_web_page_previews
    ) {
      const tomorrow = (new Date().getTime() + 24 * 60 * 60 * 1000) / 1000
      await (bot.telegram as any).restrictChatMember(chat.id, user.id, {
        until_date: tomorrow,
        can_send_messages: true,
        can_send_media_messages: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
      })
    }
  } catch (err) {
    await report(err)
  }
}

async function generateEquationOrImage(chat: InstanceType<Chat>) {
  const equation =
    chat.captchaType === CaptchaType.DIGITS ? generateEquation() : undefined
  const image =
    chat.captchaType === CaptchaType.IMAGE ? await getImageCaptcha() : undefined
  return { equation, image } as {
    equation?: Equation
    image?: { png: any; text: string }
  }
}

function getCandidate(
  ctx: ContextMessageUpdate,
  user: User,
  notificationMessage?: Message,
  equation?: Equation,
  image?: {
    png: any
    text: string
  }
): Candidate {
  return {
    id: user.id,
    timestamp: new Date().getTime(),
    captchaType: ctx.dbchat.captchaType,
    messageId: notificationMessage ? notificationMessage.message_id : undefined,
    equation,
    entryChatId: ctx.chat.id,
    entryMessageId: ctx.message.message_id,
    imageText: image ? image.text : undefined,
    username: user.username,
  }
}

async function notifyCandidate(
  ctx: ContextMessageUpdate,
  candidate: User,
  equation?: Equation,
  image?: { png: Buffer; text: string }
) {
  const chat = ctx.dbchat
  const captchaMessage = ctx.dbchat.captchaMessage
    ? cloneDeep(ctx.dbchat.captchaMessage)
    : undefined
  const warningMessage = strings(chat, `${chat.captchaType}_warning`)
  const extra =
    chat.captchaType !== CaptchaType.BUTTON
      ? Extra.HTML(true).webPreview(false)
      : Extra.HTML(true)
          .webPreview(false)
          .markup((m) =>
            m.inlineKeyboard([
              m.callbackButton(
                chat.buttonText || strings(chat, 'captcha_button'),
                `${chat.id}~${candidate.id}`
              ),
            ])
          )
  if (
    chat.customCaptchaMessage &&
    captchaMessage &&
    (chat.captchaType !== CaptchaType.DIGITS ||
      captchaMessage.message.text.includes('$equation'))
  ) {
    const text = captchaMessage.message.text
    if (
      text.includes('$username') ||
      text.includes('$title') ||
      text.includes('$equation') ||
      text.includes('$seconds') ||
      text.includes('$fullname')
    ) {
      const messageToSend = constructMessageWithEntities(
        captchaMessage.message,
        {
          $username: getUsername(candidate),
          $fullname: getName(candidate),
          $title: (await ctx.getChat()).title,
          $equation: equation ? (equation.question as string) : '',
          $seconds: `${chat.timeGiven}`,
        },
        getLink(candidate)
      )
      let formattedText = (Markup as any).formatHTML(
        messageToSend.text,
        messageToSend.entities
      )
      if (!todorantExceptions.includes(ctx.chat.id)) {
        formattedText = `${formattedText}\n${todorantAddition}`
      }
      if (image) {
        return ctx.replyWithPhoto({ source: image.png } as any, {
          caption: formattedText,
          parse_mode: 'HTML',
        })
      } else {
        return ctx.telegram.sendMessage(
          chat.id,
          formattedText,
          extra as ExtraReplyMessage
        )
      }
    } else {
      const message = cloneDeep(captchaMessage.message)
      const formattedText = (Markup as any).formatHTML(
        message.text,
        message.entities
      )
      message.text = todorantExceptions.includes(ctx.chat.id)
        ? `${getUsername(candidate)}\n\n${formattedText}`
        : `${getUsername(candidate)}\n\n${formattedText}\n${todorantAddition}`
      try {
        const sentMessage = await ctx.telegram.sendCopy(
          chat.id,
          message,
          extra as ExtraReplyMessage
        )
        return sentMessage
      } catch (err) {
        message.entities = []
        const sentMessage = await ctx.telegram.sendCopy(
          chat.id,
          message,
          extra as ExtraReplyMessage
        )
        return sentMessage
      }
    }
  } else {
    if (image) {
      return ctx.replyWithPhoto({ source: image.png } as any, {
        caption: todorantExceptions.includes(ctx.chat.id)
          ? `<a href="tg://user?id=${candidate.id}">${getUsername(
              candidate
            )}</a>${warningMessage} (${chat.timeGiven} ${strings(
              chat,
              'seconds'
            )})`
          : `<a href="tg://user?id=${candidate.id}">${getUsername(
              candidate
            )}</a>${warningMessage} (${chat.timeGiven} ${strings(
              chat,
              'seconds'
            )})\n${todorantAddition}`,
        parse_mode: 'HTML',
      })
    } else {
      return ctx.replyWithMarkdown(
        todorantExceptions.includes(ctx.chat.id)
          ? `${
              chat.captchaType === CaptchaType.DIGITS
                ? `(${equation.question}) `
                : ''
            }<a href="tg://user?id=${candidate.id}">${getUsername(
              candidate
            )}</a>${warningMessage} (${chat.timeGiven} ${strings(
              chat,
              'seconds'
            )})`
          : `${
              chat.captchaType === CaptchaType.DIGITS
                ? `(${equation.question}) `
                : ''
            }<a href="tg://user?id=${candidate.id}">${getUsername(
              candidate
            )}</a>${warningMessage} (${chat.timeGiven} ${strings(
              chat,
              'seconds'
            )})\n${todorantAddition}`,
        extra
      )
    }
  }
}

async function greetUser(
  ctx: ContextMessageUpdate,
  unsafeUser?: User | Function
) {
  let user: User | undefined
  if (unsafeUser && !isFunction(unsafeUser)) {
    user = unsafeUser as User
  }
  try {
    if (ctx.dbchat.greetsUsers && ctx.dbchat.greetingMessage) {
      const message = constructMessageWithEntities(
        ctx.dbchat.greetingMessage.message,
        {
          $title: (await ctx.getChat()).title,
          $username: getUsername(user || ctx.from),
          $fullname: getName(user || ctx.from),
        },
        getLink(user || ctx.from)
      )
      let originalText = ctx.dbchat.greetingMessage.message.text
      const needsUsername =
        !originalText.includes('$username') &&
        !originalText.includes('$fullname')
      // Add the @username of the greeted user at the end of the message if no $username was provided
      if (needsUsername) {
        const username = getUsername(user || ctx.from)
        const initialLength = `${message.text}\n\n`.length
        message.text = `${message.text}\n\n${username}`
        if (!message.entities) {
          message.entities = []
        }
        message.entities.push({
          type: 'text_link',
          offset: initialLength,
          length: username.length,
          url: getLink(user || ctx.from),
        })
      }
      // Send the message
      let messageSent: Message
      try {
        messageSent = await ctx.telegram.sendCopy(
          ctx.dbchat.id,
          message,
          ctx.dbchat.greetingButtons
            ? Extra.webPreview(false).markup((m) =>
                m.inlineKeyboard(
                  ctx.dbchat.greetingButtons
                    .split('\n')
                    .map((s) => {
                      const components = s.split(' - ')
                      return m.urlButton(components[0], components[1])
                    })
                    .map((v) => [v])
                )
              )
            : Extra.webPreview(false)
        )
      } catch (err) {
        message.entities = []
        messageSent = await ctx.telegram.sendCopy(
          ctx.dbchat.id,
          message,
          ctx.dbchat.greetingButtons
            ? Extra.webPreview(false).markup((m) =>
                m.inlineKeyboard(
                  ctx.dbchat.greetingButtons
                    .split('\n')
                    .map((s) => {
                      const components = s.split(' - ')
                      return m.urlButton(components[0], components[1])
                    })
                    .map((v) => [v])
                )
              )
            : Extra.webPreview(false)
        )
      }

      // Delete greeting message if requested
      if (ctx.dbchat.deleteGreetingTime && messageSent) {
        setTimeout(async () => {
          try {
            await ctx.telegram.deleteMessage(
              messageSent.chat.id,
              messageSent.message_id
            )
          } catch (err) {
            // Do nothing
          }
        }, ctx.dbchat.deleteGreetingTime * 1000)
      }
    }
  } catch (err) {
    await report(err)
  }
}

// Check if needs to ban
setInterval(async () => {
  if (!checking) {
    check()
  }
}, 15 * 1000)

let checking = false
async function check() {
  checking = true
  try {
    const chats = await findChatsWithCandidates()
    console.log(`Found ${chats.length} chats with candidates`)
    for (const chat of chats) {
      // Check candidates
      const candidatesToDelete = []
      for (const candidate of chat.candidates) {
        if (
          new Date().getTime() - candidate.timestamp <
          chat.timeGiven * 1000
        ) {
          continue
        }
        candidatesToDelete.push(candidate)
      }
      if (candidatesToDelete.length) {
        console.log(
          `Kicking ${candidatesToDelete.length} candidates at ${chat.id}`
        )
      }
      try {
        await kickCandidates(chat, candidatesToDelete)
      } catch (err) {
        report(err, 'kickCandidatesAfterCheck')
      }
      // Check restricted users
      const restrictedToDelete = []
      for (const candidate of chat.restrictedUsers) {
        if (new Date().getTime() - candidate.timestamp > 24 * 60 * 60 * 1000) {
          restrictedToDelete.push(candidate)
        }
      }
      try {
        await modifyRestrictedUsers(chat, false, restrictedToDelete)
      } catch (err) {
        report(err, 'removeRestrictAfterCheck')
      }
    }
  } catch (err) {
    report(err, 'checking candidates')
  } finally {
    console.log('Finished checking chats with candidates')
    checking = false
  }
}

function addKickedUser(chat: Chat, urerId: number) {
  if (!chat.deleteEntryOnKick) {
    return
  }
  try {
    if (kickedIds[chat.id]) {
      kickedIds[chat.id].push(urerId)
    } else {
      kickedIds[chat.id] = [urerId]
    }
  } catch (err) {
    // Do nothing
  }
}
