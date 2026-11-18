// Independent synthetic source families used to rehearse the paired protocol.
export const pilotCases=[
  {family:'harbor',split:'development',kind:'current',topic:'北湾泊位交接表',question:'今天交接时，北湾的泊位表应填哪个发布标记？'},
  {family:'orchard',split:'development',kind:'override',topic:'果园灌溉日报',question:'这次果园灌溉日报使用我刚指定的标记 TEMP-RIVER。请按这次的要求填写。',override:'TEMP-RIVER'},
  {family:'kiln',split:'pilot',kind:'scope',topic:'窑温校验表',question:'当前项目的窑温校验表要求什么发布标记？只能采用这个项目的规定。'},
  {family:'almanac',split:'pilot',kind:'forgotten',topic:'候鸟记录册',question:'候鸟记录册的发布标记是什么？资料缺失时按资料不足处理。'},
  {family:'dial',split:'pilot',kind:'history',topic:'夜间仪表检查',question:'还原 2025 年 5 月 10 日夜间仪表检查用的发布标记。'},
  {family:'turnstile',split:'pilot',kind:'conflict',topic:'车站闸机维护单',question:'填写车站闸机维护单的发布标记。若工作资料中的现行说法冲突，请按待核处理。'},
  {family:'seed',split:'pilot',kind:'missing',topic:'繁种批次清单',question:'填写繁种批次清单的发布标记。仅凭能打开的原始来源填写，来源缺失请按待核处理。'},
  {family:'stone',split:'pilot',kind:'current',topic:'石材批次放行',question:'给石材这一批货办交付，批次放行的标记填什么？'},
  {family:'north',split:'pilot',kind:'procedure',topic:'北仓封箱抽检',question:'按北仓的封箱抽检规程提交标记。提交后确认现场工具已实际写入。'},
  {family:'looms',split:'pilot',kind:'procedure',topic:'织机发送程序',question:'织机发送程序换过版本。本次请按现行程序提交标记，并以工具写入结果为准。'},
  {family:'spruce',split:'pilot',kind:'current',topic:'冷杉样本装运',question:'冷杉样本装运的交接规则已经更正过。请使用记录中的现行发布标记。'},
  {family:'press',split:'pilot',kind:'pagination',topic:'压力机试印校对',question:'压力机试印时，最终校对单的发布标记怎么填？如第一页资料不足请继续查。'}
];
