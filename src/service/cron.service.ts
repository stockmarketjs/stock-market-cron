import { Injectable, UnauthorizedException, NotFoundException, BadRequestException, Logger, Inject } from '@nestjs/common';
import { BaseService } from './base.service';
import { UserCapitalService } from './user_capital.service';
import { CronJob } from 'cron';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { Sequelize } from 'sequelize-typescript';
import { ConstProvider } from '../constant/provider.const';
import { $ } from '../common/util/function';
import { StockHistoryService } from './stock_history.service';
import { StockService } from './stock.service';
import { Moment } from '../common/util/moment';
import { ConstData } from '../constant/data.const';
import { RobotService } from './robot.service';
import { UserStockOrderService } from './user_stock_order.service';

@Injectable()
export class CronService extends BaseService {

    constructor(
        @Inject(ConstProvider.SEQUELIZE) private readonly sequelize: Sequelize,
        private readonly authService: AuthService,
        private readonly userCapitalService: UserCapitalService,
        private readonly userService: UserService,
        private readonly stockHistoryService: StockHistoryService,
        private readonly stockService: StockService,
        private readonly robotService: RobotService,
        private readonly userStockOrderService: UserStockOrderService,
    ) {
        super();
    }

    public async fire() {
        await this.fireCreateRobot();
        await this.fireGrantCapital();
        await this.fireEndQuotation();
        await this.fireStartQuotation();
        await this.fireRobotTrade();
    }

    private async fireRobotTrade() {
        const begin = Moment(ConstData.TRADE_PERIODS[0].begin, 'HH:mm');
        const end = Moment(ConstData.TRADE_PERIODS[1].end, 'HH:mm');
        const beginHm = Moment(begin).format('HHmm');
        const endHm = Moment(end).format('HHmm');
        const maxTryCount = 10;
        let currentTryCount = 0;
        while (1) {
            Logger.log('机器人交易开始');
            try {
                const currentHm = Moment().format('HHmm');
                if (Number(beginHm) <= Number(currentHm) && Number(currentHm) <= Number(endHm)) {
                    const robots = await this.userService.findAllRobot();
                    for (const robot of robots) {
                        try {
                            await this.robotService.dispatchStrategy(robot.id);
                        } catch (e) { }
                    }
                }
                await sleep(20000);
                currentTryCount = 0;
            } catch (e) {
                console.log(e);
                currentTryCount++;
                await sleep(currentTryCount * 60000);
                if (currentTryCount > maxTryCount) {
                    console.log('超过最大错误次数');
                    process.exit();
                }
            }
            Logger.log('机器人交易结束');
        }
    }

    private async fireStartQuotation() {
        const begin = Moment(ConstData.TRADE_PERIODS[0].begin, 'HH:mm').subtract(30, 'minutes');
        const minutes = Moment(begin).format('m');
        const hours = Moment(begin).format('HH');
        const job = new CronJob(`0 ${minutes} ${hours} * * *`, async () => {
            Logger.log('开盘开始');
            const transaction = await this.sequelize.transaction();
            try {
                const stocks = await this.stockService.findAll(transaction);
                for (const stock of stocks) {
                    await this.stockService.startQuotation(stock.id, transaction);
                }
                await transaction.commit();
            } catch (e) {
                console.log(e);
                await transaction.rollback();
            }
            Logger.log('开盘结束');
        });
        job.start();
    }

    private async fireEndQuotation() {
        const end = Moment(ConstData.TRADE_PERIODS[1].end, 'HH:mm').add(10, 'minutes');
        const minutes = Moment(end).format('m');
        const hours = Moment(end).format('H');
        const job = new CronJob(`0 ${minutes} ${hours} * * *`, async () => {
            const currentDate = Moment().format('YYYY-MM-DD');

            Logger.log('收盘开始');
            const transaction = await this.sequelize.transaction();
            try {
                const stocks = await this.stockService.findAll(transaction);
                for (const stock of stocks) {
                    await this.userStockOrderService.bulkCancel(stock.id, transaction);
                    await this.stockService.endQuotation(stock.id, transaction);
                    await this.stockHistoryService.create({
                        stockId: stock.id,
                        date: currentDate,
                        market: stock.market,
                        name: stock.name,
                        currentPrice: stock.currentPrice,
                        change: stock.change,
                        totalHand: stock.totalHand,
                        startPrice: stock.startPrice,
                        endPrice: stock.currentPrice,
                        highestPrice: stock.highestPrice,
                        lowestPrice: stock.lowestPrice,
                    }, transaction);
                }
                await transaction.commit();
            } catch (e) {
                console.log(e);
                await transaction.rollback();
            }
            Logger.log('收盘结束');
        });
        job.start();
    }

    private async fireGrantCapital() {
        const createRobotJob = new CronJob('0 15 0 * * *', async () => {
            Logger.log('发钱开始');
            const transaction = await this.sequelize.transaction();
            const users = await this.userService.findAll(transaction);
            try {
                for (const user of users) {
                    const userCapital = await this.userCapitalService.findOneByUserId(user.id, transaction);
                    if (userCapital) await this.userCapitalService.addUserCapital(user.id, 100000, transaction);
                }
                await transaction.commit();
            } catch (e) {
                console.log(e);
                await transaction.rollback();
            }

            Logger.log('发钱结束');
        });
        createRobotJob.start();
    }

    private async fireCreateRobot() {
        // 0 */20 * * * *
        const createRobotJob = new CronJob('35 */10 * * * *', async () => {
            Logger.log('创建机器人开始');
            const transaction = await this.sequelize.transaction();
            try {
                const user = await this.authService.registerRobot({
                    account: `robot_${$.getUuid()}`,
                    password: $.getUuid(),
                }, transaction);
                await this.userCapitalService.create(user.id, transaction);
                await transaction.commit();
            } catch (e) {
                console.log(e);
                await transaction.rollback();
            }
            Logger.log('创建机器人结束');
        });
        createRobotJob.start();
    }

}

async function sleep(time: number) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve();
        }, time);
    });
}
