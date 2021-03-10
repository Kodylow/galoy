import dotenv from "dotenv";
import { rule, shield } from 'graphql-shield';
import { GraphQLServer } from 'graphql-yoga';
import * as jwt from 'jsonwebtoken';
import _ from 'lodash';
import moment from "moment";
import mongoose from "mongoose";
import path from "path";
import pino from 'pino';
// https://nodejs.org/api/esm.html#esm_no_require_exports_module_exports_filename_dirname
// TODO: to use when switching to module
// import { fileURLToPath } from 'url';
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
import PinoHttp from "pino-http";
import swStats from 'swagger-stats';
import util from 'util';
import { v4 as uuidv4 } from 'uuid';
import { getMinBuildNumber, mainCache } from "../cache";
import { nodeStats } from "../lndUtils";
import { getAsyncRedisClient } from "../lock";
import { setupMongoConnection } from "../mongodb";
import { sendNotification } from "../notification";
import { Price } from "../priceImpl";
import { User } from "../schema";
import { login, requestPhoneCode } from "../text";
import { OnboardingEarn } from "../types";
import { UserWallet } from "../userWallet";
import { baseLogger, customLoggerPrefix } from "../utils";
import { WalletFactory, WalletFromUsername } from "../walletFactory";
import { lnd } from "../lndConfig"


dotenv.config()

const graphqlLogger = baseLogger.child({ module: "graphql" })


const pino_http = PinoHttp({
  logger: graphqlLogger,
  wrapSerializers: false,

  // Define custom serializers
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: (res) => ({
      // FIXME: kind of a hack. body should be in in req. but have not being able to do it.
      body: res.req.body,
      ...pino.stdSerializers.res(res)
    })
  },
  reqCustomProps: function(req) {
    return {
      // FIXME: duplicate parsing from graphql context.
      token: verifyToken(req)
    }
  },
  autoLogging: {
    ignorePaths: ["/healthz"]
  }
})

const commitHash = process.env.COMMITHASH
const buildTime = process.env.BUILDTIME
const helmRevision = process.env.HELMREVISION

const resolvers = {
  Query: {
    me: async (_, __, { uid, user }) => {
      const { phone, username, contacts, language } = user

      return {
        id: uid,
        level: 1,
        phone,
        username,
        contacts,
        language
      }
    },

    // legacy, before handling multi currency account
    wallet: async (_, __, { wallet }) => ([{
      id: "BTC",
      currency: "BTC",
      balance: async () => (await wallet.getBalances())["BTC"],
      transactions: () => wallet.getTransactions(),
      csv: () => wallet.getStringCsv()
    }]),

    // new way to return the balance
    // balances are distinc between USD and BTC
    // but transaction are common, because they could have rely both on USD/BTC
    wallet2: async (_, __, { wallet }) => {
      const balances = await wallet.getBalances()

      return {
        transactions: wallet.getTransactions(),
        balances: wallet.user.currencies.map(item => ({
          id: item.id,
          balance: balances[item.id],
        }))
      }
    },
    nodeStats: async () => nodeStats({lnd}),
    buildParameters: async () => {
      const { minBuildNumber, lastBuildNumber } = await getMinBuildNumber()
      return {
        id: lastBuildNumber,
        commitHash: () => commitHash,
        buildTime: () => buildTime,
        helmRevision: () => helmRevision,
        minBuildNumberAndroid: minBuildNumber,
        minBuildNumberIos: minBuildNumber,
        lastBuildNumberAndroid: lastBuildNumber,
        lastBuildNumberIos: lastBuildNumber,
      }
    },
    prices: async (_, { length = 365 * 24 * 10 }, {logger}) => {

      const key = "lastCached"
      let value
    
      value = mainCache.get(key);
      if ( value === undefined ){
        const price = new Price({logger})
        const lastCached = await price.lastCached()
        // TODO: maybe have a better way to reset the cache.
        // if we have 300 seconds of cache here, but we also only fetch from prometheus value only every 300 seconds
        // then the price value could be stale up to 600 seconds on the client side
        mainCache.set( key, lastCached, 30 )
        value = lastCached
      }
    
      return value.splice(-length)
    },
    earnList: async (_, __, { uid, user }) => {
      const response: Object[] = []
      const earned = user?.earn || []

      for (const [id, value] of Object.entries(OnboardingEarn)) {
        response.push({
          id,
          value,
          completed: earned.findIndex(item => item === id) !== -1,
        })
      }

      return response
    },
    getLastOnChainAddress: async (_, __, { wallet }) => ({ id: wallet.getLastOnChainAddress() }),

    maps: async () => {
      // TODO: caching
      const users = await User.find({ title: { $exists: true }, coordinate: { $exists: true }}, {username: 1, title: 1, coordinate: 1})
      return users.map(item => ({
        id: item.username,
        username: item.username,
        title: item.title,
        coordinate: {
          latitude: item.coordinate.coordinates[0],
          longitude: item.coordinate.coordinates[1]
        }
      }))
    },
    usernameExists: async (_, { username }) => await UserWallet.usernameExists({ username })

  },
  Mutation: {
    requestPhoneCode: async (_, { phone }, { logger }) => ({ success: requestPhoneCode({ phone, logger }) }),
    login: async (_, { phone, code }, { logger }) => ({ token: login({ phone, code, logger }) }),
    updateUser: async (_, __, { wallet }) => ({
      // FIXME manage uid
      // TODO only level for now
      setLevel: async () => {
        const result = await wallet.setLevel({ level: 1 })
        return {
          id: wallet.uid,
          level: result.level,
        }
      },
      setUsername: async ({ username }) => await wallet.setUsername({ username }),
      setLanguage: async ({ language }) => await wallet.setLanguage({ language })
    }),
    updateContact: async (_, __, { user }) => ({
      setName: async ({ username, name }) => {
        user.contacts.filter(item => item.id === username)[0].name = name
        await user.save()
        return true
      }
    }),
    publicInvoice: async (_, { username }, { logger }) => {
      const wallet = await WalletFromUsername({ username, logger })
      return {
        addInvoice: async ({ value, memo }) => wallet.addInvoice({ value, memo, selfGenerated: false }),
        updatePendingInvoice: async ({ hash }) => wallet.updatePendingInvoice({ hash })
      }
    },
    invoice: async (_, __, { wallet }) => ({
      addInvoice: async ({ value, memo }) => wallet.addInvoice({ value, memo }),
      updatePendingInvoice: async ({ hash }) => wallet.updatePendingInvoice({ hash }),
      payInvoice: async ({ invoice, amount, memo }) => wallet.pay({ invoice, amount, memo }),
      payKeysendUsername: async ({ destination, username, amount, memo }) => wallet.pay({ destination, username, amount, memo }),
      getFee: async ({ destination, amount, invoice, memo }) => wallet.getLightningFee({ destination, amount, invoice, memo })
    }),
    earnCompleted: async (_, { ids }, { wallet }) => wallet.addEarn(ids),
    deleteUser: () => {
      // TODO
    },
    onchain: async (_, __, { wallet }) => ({
      getNewAddress: () => wallet.getOnChainAddress(),
      pay: ({ address, amount, memo }) => ({ success: wallet.onChainPay({ address, amount, memo }) }),
      getFee: ({ address }) => wallet.getOnchainFee({ address }),
    }),
    addDeviceToken: async (_, { deviceToken }, { user }) => {
      user.deviceToken.addToSet(deviceToken)
      // TODO: check if this is ok to shared a mongoose user instance and mutate it.
      await user.save()
      return { success: true }
    },

    // FIXME test
    testMessage: async (_, __, { user, logger }) => {
      // throw new LoggedError("test error")
      await sendNotification({
        user,
        title: "Title",
        body: `New message sent at ${moment.utc().format('YYYY-MM-DD HH:mm:ss')}`,
        logger
      })
      return { success: true }
    },
  }
}


function verifyToken(req) {

  let token
  try {
    const auth = req.get('Authorization')

    if (!auth) {
      return null
    }

    if (auth.split(" ")[0] !== "Bearer") {
      throw Error("not a bearer token")
    }

    const raw_token = auth.split(" ")[1]
    token = jwt.verify(raw_token, process.env.JWT_SECRET);

    // TODO assert bitcoin network
  } catch (err) {
    return null
    // TODO return new AuthenticationError("Not authorised"); ?
    // ie: differenciate between non authenticated, and not authorized
  }
  return token
}

const isAuthenticated = rule({ cache: 'contextual' })(
  async (parent, args, ctx, info) => {
    if(ctx.uid === null) {
      return new Error(`${util.inspect({ message: 'Not authorised!', request: ctx.request.body }, false, Infinity)}`)
    }
    return true
  },
)

const permissions = shield({
  Query: {
    // prices: not(isAuthenticated),
    // earnList: isAuthenticated,
    wallet: isAuthenticated,
    me: isAuthenticated,
  },
  Mutation: {
    // requestPhoneCode: not(isAuthenticated),
    // login: not(isAuthenticated),

    onchain: isAuthenticated,
    invoice: isAuthenticated,
    earnCompleted: isAuthenticated,
    updateUser: isAuthenticated,
    deleteUser: isAuthenticated,
    addDeviceToken: isAuthenticated,
  },
}, { allowExternalErrors: true }) // TODO remove to not expose internal error


const server = new GraphQLServer({
  typeDefs: path.join(__dirname, "../schema.graphql"),
  resolvers,
  middlewares: [permissions],
  context: async (context) => {
    const token = verifyToken(context.request)
    const uid = token?.uid ?? null
    const user = !!uid ? await User.findOne({ _id: uid }) : null
    // @ts-ignore
    const logger = graphqlLogger.child({ token, id: context.request.id, body: context.request.body })
    const wallet = !!uid ? await WalletFactory({ user, logger }) : null
    return {
      ...context,
      logger,
      uid,
      wallet,
      user
    }
  }
})

// injecting unique id to the request for correlating different logs messages
// TODO: use a jaeger standard instead to be able to do distributed tracing 
server.express.use(function(req, res, next) {
  // @ts-ignore
  req.id = uuidv4();
  next();
});

server.express.use(pino_http)
server.express.use(swStats.getMiddleware({
  uriPath: "/swagger",
  // no authentication but /swagger/* should be protected from access outside the cluster
  // this is done with nginx 
}))

// Health check
server.express.get('/healthz', async function(req, res) {
  const isMongoAlive = mongoose.connection.readyState == 1 ? true : false
  const isRedisAlive = await getAsyncRedisClient().ping() === 'PONG'
  res.status((isMongoAlive && isRedisAlive) ? 200 : 503).send();
});

const options = {
  // tracing: true,
  formatError: err => {
    // FIXME
    if (_.startsWith(err.message, customLoggerPrefix)) {
      err.message = err.message.slice(customLoggerPrefix.length)
    } else {
      baseLogger.error({err}, "graphql catch-all error"); 
    }
    // return defaultErrorFormatter(err)
    return err
  },
  endpoint: '/graphql',
  playground: process.env.NETWORK === 'mainnet' ? 'false' : '/'
}

setupMongoConnection().then(() => {
  server.start(options, ({ port }) =>
    graphqlLogger.info(
      `Server started, listening on port ${port} for incoming requests.`,
    ),
  )
}).catch((err) => graphqlLogger.error(err, "server error"))
