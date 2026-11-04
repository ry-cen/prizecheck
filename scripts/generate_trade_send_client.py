"""Generate only the initial Trade send contract from the actual API.

The broader thread clients are a separate integration gate. Share the existing
TradesError identity and transport emitter so the real composer sees all detail.
"""
import client_generator as gen

TARGET = 'web/src/trade_send_generated.ts'
NAMES = ('TradeLineRequest', 'TradeCashRequest', 'SendTradeProposal',
         'TradeParty', 'TradeCard', 'TradeCash', 'TradeView', 'ReplayedTradeSend')


def render(openapi):
    schemas = openapi['components']['schemas']
    return gen.assemble([
        gen.header('generate_trade_send_client'),
        'import { TradesError } from "./trades_generated";',
        *gen.DOUBLE.aliases(schemas, NAMES),
        'export type TradeSendResult = TradeView | ReplayedTradeSend;',
        gen.json_request(gen.detail_failure_lines('TradesError', 'TRADES_REQUEST_FAILED')),
        "export const sendTradeProposal = (body: SendTradeProposal): Promise<TradeSendResult> => "
        "request<TradeSendResult>('/api/trades', 'POST', body);\n",
    ])


if __name__ == '__main__':
    gen.main(__name__)
