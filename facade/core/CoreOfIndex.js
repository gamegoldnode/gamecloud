/**
 * Created by Administrator on 2017-05-13.
 */
let facade = require('../Facade')
let {UserStatus, CommMode} = facade.const

/**
 * 索引服对应的门面类
 */
class CoreOfIndex extends facade.CoreOfBase
{
    constructor($env){
        super($env);
        
        this.testRoute = new Set(); //直连测试服的openid列表

        //中间件设定
        this.middlewareSetting = {
            default: ['parseParams', 'commonHandle']
        };
        
        //载入框架规定的Service
        facade.config.filelist.mapPackagePath(`${__dirname}/../service/${this.constructor.name}`).map(srv=>{
            let srvObj = require(srv.path);
            this.service[srv.name.split('.')[0]] = new srvObj(this);
        });

        //载入控制器
        this.$router = {};
        facade.config.filelist.mapPackagePath(`${__dirname}/../control/${this.constructor.name}`).map(ctrl=>{
            let ctrlObj = require(ctrl.path);
            let token = ctrl.name.split('.')[0];
            this.control[token] = new ctrlObj(this);

            //读取控制器自带的中间件设置
            if(!!this.control[token].middleware){
                this.middlewareSetting[token] = this.control[token].middleware;
            }
            //读取控制器自带的Url路由设置
            if(!!this.control[token].router){
                this.$router[token] = this.control[token].router;
            }
        });
    }

    /**
     * 加载用户自定义模块
     */
    async loadModel() {
        super.loadModel();

        facade.config.filelist.mapPath(`app/control/${this.constructor.name}`).map(ctrl=>{
            let ctrlObj = require(ctrl.path);
            let token = ctrl.name.split('.')[0];
            this.control[token] = new ctrlObj(this);

            //读取控制器自带的中间件设置
            if(!!this.control[token].middleware){
                this.middlewareSetting[token] = this.control[token].middleware;
            }
            //读取控制器自带的Url路由设置
            if(!!this.control[token].router){
                this.$router[token] = this.control[token].router;
            }
        });

        //载入用户自定义Service
        facade.config.filelist.mapPath(`app/service/${this.constructor.name}`).map(srv=>{
            let srvObj = require(srv.path);
            this.service[srv.name.split('.')[0]] = new srvObj(this);
        });
    }

    /**
     * 映射自己的服务器类型数组，提供给核心类的类工厂使用
     * @returns {Array}
     */
    static get mapping() {
        if(!this.$mapping) {
            this.$mapping = ['Index'];
        }
        return this.$mapping;
    }
    static set mapping(val) {
        this.$mapping = val;
    }

    routeList(){
        let ret = [];
        this.testRoute.forEach((item, sameItem, s)=>{
            ret.push(item);
        })
        if(ret.length == 0){
            ret.push('添加测试路由');
        }
        return ret;
    }

    async Start(app){
        super.Start(app);

        //载入路由配置
        Object.keys(this.$router).map(id=>{
            app.use("/", this.makeRouter(id, this.$router[id]));
        });

        //缓存管理器
        this.cacheMgr = new facade.tools.cache(this);

        console.time(`${this.options.serverType}${this.options.serverId} Load Db`);
        await this.service.dailyactivity.loadDb(); //载入世界Boss活动信息
        this.loadAllUsers(()=>{
            console.timeEnd(`${this.options.serverType}${this.options.serverId} Load Db`);
            console.log(`${this.options.serverType}.${this.options.serverId}: 数据载入完成，准备启动网络服务...`);
            this.StartSocketServer(app);
        });

        //世界Boss活动检测，只在Index Server上进行
        this.autoTaskMgr.addCommonMonitor(fo=>{
            fo.service.dailyactivity.tick();
            return false;
        });
    }

    /**
     * 根据DomainId列表，批量查询并返回用户对象列表
     * @param {*} list 
     */
    async getUserIndexOfAll(list){
        let ret = {};
        let query = this.cacheMgr.get(list);
        if(!!query){
            query.map(uo=>{
                if(!!uo){ //由于对用户领域进行了猜测，这里要判断下查询结果是否为空
                    ret[`${uo.domain}.${uo.openid}`] = uo;
                }
            });
        }
        return ret;
    }

    async getExcellentUser(openid) {
        let uList = await this.getUserIndexOfAll(facade.CoreOfLogic.mapping.reduce((sofar, cur)=>{
            sofar.push(`tx.${cur}.${openid}`);
            return sofar;
        }, []));
        
        let sim = null;
        facade.CoreOfLogic.mapping.map(lt=>{
            let u = uList[`tx.${lt}.${openid}`];
            if(!sim) {
                sim = u;
            }
            if(!!sim && !!u) {
                sim = u.score > sim.score ? u : sim;
            }
        });
 
        return sim;
    }

    /**
     * 检索用户所在服务器信息, 如果是新用户则采用负载均衡模式分配目标服务器
     * @param domainId
     * @param openid
     */
    async getUserIndex(domain, openid, register=false){
        //计算用户唯一标识串
        let domainId = `${domain}.${openid}`;

        let uo = this.cacheMgr.get(domainId);
        if(!!uo){
            uo.status = facade.tools.Indicator.inst(uo.status).unSet(UserStatus.isNewbie).value;
        }
        else if(register) { //新用户注册
            //检测逻辑服类型
            let stype = facade.CoreOfLogic.mapping[0]; //默认的逻辑服类型

            let pl = domain.split('.');
            if(pl.length > 1) {
                if(facade.CoreOfLogic.mapping.indexOf(pl[1]) != -1) {
                    stype = pl[1];
                }
            }

            if(!this.serversInfo[stype]) {//非法类型
                return null;
            }

            //负载均衡
            let serverId = (facade.util.hashCode(domainId) % this.serverNum(stype)) + 1;   //通过hash计算命中服务器编号
            let sn = `${stype}.${serverId}`;

            //避免新用户进入不合适的服务器（人数超限或状态不正常）
            let recy = 0, isFind = false;
            while(recy++ < this.serverNum(stype)){//检测服务器人数和运行状况
                let svr = this.service.servers.getServer(stype, serverId);
                if(!!svr && this.service.servers.userNum[sn] < this.options.MaxRegister){
                    isFind = true;
                    break;
                }

                serverId = serverId % this.serverNum(stype) + 1; //循环递增
                sn = `${stype}.${serverId}`;
            }
            
            if(!isFind){
                return null;
            }
            
            //寻找到了合适的服务器，累计服务器人数
            this.service.servers.userNum[sn] += 1;
            
            //为注册用户预登记
            uo = {
                hisGateNo: 1,
                role: 1001,
                name: '',
                icon: '',
                stype:stype, 
                sid:serverId, 
                score:0, 
                status: UserStatus.isNewbie,
                domain:domain, 
                openid:openid
            }
            this.setUserIndex(uo);
        }
        return uo;
    }

    /**
     * 将用户对象存回Redis
     * @param {*} uo 
     */
    setUserIndex(uo){
        if(!!uo && uo.domain && uo.openid){
            this.cacheMgr.set(`${uo.domain}.${uo.openid}`, uo);
        }
    }

    /**
     * 加载全部用户索引
     * @returns {Promise.<void>}
     */
    async loadAllUsers(cb){
        try{
            //遍历所有服务器，以便加载所有逻辑服用户的索引
            for(let stype in this.serversInfo) {
                if(facade.CoreOfLogic.mapping.indexOf(stype) != -1) {
                    for(let id in this.serversInfo[stype]){
                        let item = this.serversInfo[stype][id];
                        await this.service.servers.loadIndex(item.mysql.db, item.mysql.sa, item.mysql.pwd, stype, id); //载入分服的用户
                    }
                }
            }

            cb(); //外部传入的回调
        }
        catch(e){
            console.error(e);
        }
    }
}

exports = module.exports = CoreOfIndex;