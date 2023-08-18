import {
  IMessage,
  MessageBusConfig,
  MessageHandler,
  MessageHandlerParams,
  QueueConfig,
} from 'Types';
import {
  info,
  log,
  error as logError,
  pushToLastConsumedMessages,
  pushToLastRejectedMessages,
} from 'Utils';
import { ChannelWrapper } from 'amqp-connection-manager';
import { ConsumeMessage } from 'amqplib';
import { DEFAULT_EXCHANGE_NAME } from './Const';
import { getDefaultChannel } from './channel';
import { configureMessageBus, getMessageBusConfig } from './config';

const EXP_BACKOFF_HEADER_NAME = 'x-backoff-sec';
const EXP_BACKOFF_MULTIPLIER = 4;
const MAX_EXP_BACKOFF = 1000 * 1024;

const backoffRetryMessage = async <DataType = any>({
  message,
  queue,
  channel,
  body,
  error,
}: {
  message: ConsumeMessage;
  queue: QueueConfig;
  channel: ChannelWrapper;
  body: DataType;
  error?: Error;
}) => {
  const currentBackoffSeconds =
    parseInt(message.properties.headers[EXP_BACKOFF_HEADER_NAME]) || 0;
  const nextBackoffSeconds = Math.min(
    MAX_EXP_BACKOFF,
    currentBackoffSeconds
      ? currentBackoffSeconds * EXP_BACKOFF_MULTIPLIER
      : 1000
  );
  const backoffQueueName = `${queue.name}.backoff-${Math.floor(
    nextBackoffSeconds / 1000
  )}s+${message.fields.routingKey}`;

  if (error) {
    logError(
      `Error when consuming message from queue "${queue.name}". The message will be requeued to "${backoffQueueName}". Routing key: ${message.fields.routingKey}. ${error.stack}`
    );
  } else {
    log(
      `Message from queue "${queue.name}" was canceled. The message will be requeued to "${backoffQueueName}". Routing key: ${message.fields.routingKey}`
    );
  }

  try {
    log(
      `Asserting backoff queue for routing key "${message.fields.routingKey}".`
    );
    await channel.assertQueue(backoffQueueName, {
      ...queue.options,
      messageTtl: nextBackoffSeconds,
      deadLetterExchange:
        queue.options?.deadLetterExchange || DEFAULT_EXCHANGE_NAME,
      deadLetterRoutingKey: message.fields.routingKey,
    });
  } catch (e) {
    logError(
      `Failed to assert queue "${queue.name}" with options ${JSON.stringify(
        queue.options
      )}: ${e}`
    );
    await channel.nack(message);
    return;
  }

  try {
    await channel.sendToQueue(backoffQueueName, body, {
      headers: {
        ...message.properties.headers,
        [EXP_BACKOFF_HEADER_NAME]: nextBackoffSeconds,
      },
    });
  } catch (e) {
    logError(`Failed to send message to the queue "${backoffQueueName}": ${e}`);
    await channel.nack(message);
    return;
  }

  await channel.ack(message);
};

interface ConsumeMessagesExtraConfig {
  /** Number of messages prefetched (and hence handled in parallel). */
  prefetchCount?: number;
}

type ConsumeMessagesConfig = MessageBusConfig & ConsumeMessagesExtraConfig;

export async function consumeMessages<Message extends IMessage>(
  queueName: string,
  handler: MessageHandler<Message>
): Promise<void>;
export async function consumeMessages<Message extends IMessage>(
  config: ConsumeMessagesConfig,
  handler: MessageHandler<Message>
): Promise<void>;

export async function consumeMessages<Message extends IMessage>(
  queueName: ConsumeMessagesConfig | string,
  handler: MessageHandler<Message>
) {
  let prefetch: number | undefined;
  if (typeof queueName !== 'string') {
    if (!queueName.queues || queueName.queues.length !== 1) {
      throw new Error(
        'You need to define exactly one queue in the passed config to consumeMessages()'
      );
    }
    const { prefetchCount, ...config } = queueName;
    await configureMessageBus(config);
    queueName = queueName.queues[0].name;
    if (prefetchCount) {
      prefetch = prefetchCount;
    }
  }

  const channel = await getDefaultChannel();
  const queue = getMessageBusConfig().queues.find((q) => q.name === queueName);
  const consumerTag = `${
    process.env.HOSTNAME || 'no.env.HOSTNAME'
  }-${Math.random().toString(36).slice(2)}`;

  if (!queue) {
    throw new Error(
      `onQueueMessage: provided queue name "${queueName}" is not present in the initial config, which includes the following queue names: ${getMessageBusConfig().queues?.map(
        (q) => q.name
      )}.`
    );
  }

  await channel.consume(
    queueName,
    async (message) => {
      if (message === null) {
        info(`Consumer ${consumerTag} was canceled.`);
        return;
      }

      let body = message.content;
      try {
        body = JSON.parse(message.content.toString());
      } catch (e) {
        log(
          `Unable to parse JSON from the message queue: ${body}. Returning original data.`
        );
      }

      let messageBackoff = false;
      const failThisMessage = async (e?: Error) => {
        if (messageBackoff) {
          return;
        }
        messageBackoff = true;
        await backoffRetryMessage({
          message,
          queue,
          channel,
          body,
          error: e,
        });
      };
      const handlerParams: MessageHandlerParams<Message> = {
        ...message.properties,
        ...message.fields,
        failThisMessage,
        key: message.fields.routingKey,
        body,
      };

      log(`<- consuming [${message.fields.routingKey}]`);
      try {
        await handler(handlerParams);

        if (!messageBackoff) {
          channel.ack(message);
          pushToLastConsumedMessages({
            key: message.fields.routingKey,
            body: body,
          });
        }
      } catch (e: any) {
        await failThisMessage(e);
        pushToLastRejectedMessages({
          key: message.fields.routingKey,
          body: body,
        });
      }
    },
    {
      consumerTag,
      prefetch,
    }
  );

  log(`✔ Listening messages from queue ${queueName}`);
}

export const messageBusStopAllConsumers = async () => {
  const channel = await getDefaultChannel();
  await channel.cancelAll();
};
