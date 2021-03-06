import {logger} from "@/server/common";
const EventSource = require('eventsource');
import mongoose, { Schema } from 'mongoose';
import {CollectionInsertOneOptions, ObjectID} from "mongodb";

export class OresStream {
  private eventSource:EventSource;
  private wiki:string;
  public constructor(wiki) {
    this.wiki = wiki;
  }

  public filterBasic(data) {
    let matchWiki = data.database === this.wiki;
    let matchNamespace = data.page_namespace == 0;
    return matchWiki && matchNamespace;
  }

  public filterIsBad(data) {
    let isDamaging = data.scores?.damaging?.prediction[0] === 'true';
    let isBadfaith = data.scores?.goodfaith?.prediction[0] === 'false';
    return isDamaging || isBadfaith;
  }


  public subscribe() {
    const url = 'https://stream.wikimedia.org/v2/stream/revision-score';

    logger.debug(`Connecting to EventStreams at ${url}`);

    const eventSource = new EventSource(url);
    eventSource.onopen = (event) => {
      logger.debug(`Stream connected: ${url}`);
    };

    eventSource.onerror = (event) => {
      logger.debug(`Ignoring Stream error: ${url}, ${JSON.stringify(event, null, 2)}`);
    };

    eventSource.onmessage = async (event) => {
      let json = JSON.parse(event.data);
      if (this.filterBasic(json)) {
        const wiki = json.database;
        const title = json.page_title;
        const pageId = json.page_id;
        const revId = json.rev_id;
        if (this.filterIsBad(json)) {
          logger.debug(`rev-score`, {wiki, title, pageId, revId});
          await mongoose.connection.db.collection(`WatchCollection_ORES`).insertOne({
            _id: `${wiki}:${revId}`,
            wiki: wiki,
            revIds: [revId],
            pageId: pageId,
            title: title,
            timestamp: Math.floor(new Date().getTime() / 1000),
            _created: new Date(),
          }, {upsert: true} as CollectionInsertOneOptions);

          logger.debug(`Inserting LASTBAD: `, {wiki, title, pageId, revId});
          await mongoose.connection.db.collection(`WatchCollection_LASTBAD`).findOneAndUpdate(
            {
              _id: `${wiki}:page-${pageId}`
            },
            {
              $set: {
                revIds: [revId],
                timestamp: Math.floor(new Date().getTime() / 1000),
                _updated: new Date(),
                '_tmp.ores': json.scores,
                '_tmp.damaging': json.scores?.damaging?.prediction[0],
                '_tmp.goodfaith': json.scores?.goodfaith?.prediction[0],
              },
              $setOnInsert: {
                _id: `${wiki}:page-${pageId}`,
                wiki: wiki,
                pageId: pageId,
                title: title,
                _created: new Date(),
              }
            }, {upsert: true});
        } else {
          logger.debug(`Removing from LASTBAD: `, {wiki, title, pageId, revId});
          await mongoose.connection.db.collection(`WatchCollection_LASTBAD`).findOneAndDelete(
            { _id: `${wiki}:page-${pageId}`});
        }
      }
    };

    this.eventSource = eventSource;
  }
}
