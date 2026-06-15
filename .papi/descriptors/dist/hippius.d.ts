import { StorageDescriptor, PlainDescriptor, TxDescriptor, RuntimeDescriptor, Enum, ApisFromDef, QueryFromPalletsDef, TxFromPalletsDef, EventsFromPalletsDef, ErrorsFromPalletsDef, ConstFromPalletsDef, ViewFnsFromPalletsDef, SS58String, FixedSizeBinary, Binary, FixedSizeArray } from "polkadot-api";
import { I5sesotjlssv2d, Iffmde3ekjedi9, I4mddgoa69c0a2, Icp0d89tlsgb4c, Ifip05kcrl65am, Ieniouoqkq4icf, Phase, Ibgl04rn6nbfm6, Ic5m5lp1oioo8r, I3qklfjubrljqh, Iag3f1hum3p4c8, I96rqo4i9p11oo, I4s6jkha20aoh0, I6lsoh4c5um3u5, I78s05f59eoi8b, I1q8tnt1cluu5j, I8ds64oj6581v0, Ia7pdug7cdsg8g, Icg2f7lij7mhun, I2l1ctuihi2mfd, TransactionPaymentReleases, I3geksg000c171, BabeDigestsNextConfigDescriptor, Idq7or56ds2f13, I4s6vifaf8k998, I200n1ov5tbcvr, I8jnd4d8ip6djo, Ia24s7cuas271t, I30cqmm2kaidet, Iff9heri56m1mb, I6mhebgj62g585, I3vhcedhm4hpvm, Ianoje3qpmo6md, Ia3t44vpf24cgg, I5rsgtofmn5lli, I4nfjdef0ibh44, I2itl2k1j2q8nf, If4gigsesqmr49, I8g8u2r2m659dq, Ia2lhg7l2hilo3, I63js2b08d3e38, Version, I8nj9dlo7lnbb3, Iba9inugg1atvo, Ib23vkkc52tqbu, I60mqgbf0p40e1, Ictkaqdbfabuek, Ia7o65280hur3p, Iasd2iat48n080, I41gemnici26aj, Irl37q7erstrb, I8s6n43okuj2b1, Ic12aht5vh2sen, StakingRewardDestination, I9o7ssi9vmhmgr, Ic3m9d6tdl6gi2, Ib3j7gb0jgs38u, Ifekshcrgkl12g, I7svnfko10tq2e, I6flrronqs3l6n, I97fulj5h3ik95, Ia8896dq44k9m4, Icgljjb6j82uhn, Iff9p3c7k6pfoi, StakingForcing, Iafq6t4rgheait, I95g6i7ilua7lq, I4ojmnsk1dchql, Iinkhfdlka9ch, I2kj4j6mp68hf8, I6ouflveob4eli, I3n8u7haiacr3o, Ifngji0jpcpvpj, I82jm9g7pufuel, I4pact7n2e9a0i, I9jd27rnpm8ttv, Iegmj7n48sc3am, I3t96o5lsq581r, I17lk5gd4jui0r, I2ejqo0lr36e3q, Ic5t26f9cp3tvk, I39k39h6vu4hbq, Idphjddn2h69vc, Ia8n1658h0bakq, If6qa32dj75gu1, I7oo2mprv1qd1s, NominationPoolsClaimPermission, I8b18sngtfv9qe, I2n348ct50b2mp, I6cs1itejju2vv, PreimageOldRequestStatus, I8j24837rs9r0t, I2bqvqrg0sbrdj, I23nq3fsgtejt, Idkbvh6dahk1v7, I1evsr8hplu1lg, I910puuahutflf, I74af64m08r6as, I9bhbof2vim227, I95l2k9b1re95f, Iahvoath23ldhv, I8uo3fpd3bcc6f, Ic17drnrq0rtgi, Idi27giun0mb9q, Idud3fdh64aqp9, Ie7atdsih6q14b, I4totqt881mlti, I7jidl7qnnq87c, I82cps8ng2jtug, I4gqmlq9k6jlk3, I2gp57ssjscm57, I43vorjrsfs83q, I9ea6lu6bbueo9, I1k1g0avb0ugrv, Itom7fk49o0c9, I794shhubguhfe, Ic2gqqe3boa6j, Iafqnechp3omqg, Irepiuosq268n, I69kk348jhe683, I4p8l84tk038s, Ifl5oat0rhcq32, I5ofvu2mgb3ik6, If8b3rdbls82p1, I3f35fplll6ic0, I2ek94e7loqjdr, I2plnma28qqa7d, I30u3t989dudrc, I41jij06egn8q0, I8052e8591l2k5, Ihfphjolmsqq1, I15h251r958qnn, I5ocim6bqhcb87, I9fmfdj27dod2r, Ie9ca3ooag8pvg, I2dlsvlc18d84, Ifv97gfrl1guc, If55bm6vm10gt4, I57odkpjf7icor, I3ks7h4esgu87b, I5tr5ve03qkqub, Ibshtksbg4cn8s, Ia79cnsrsjj9f, I826pe08hg303r, I92hdo1clkbp4g, I2r873a4ldk78h, I92tce08cbhnmn, I1liagipf62t7o, I9ul39lmd4kq7, I2igc2btujm50s, Ianojun924rii6, Ibp595vp69nb95, Iegso6e591humo, I21oce8fars5kb, I2nnfiu9n558kd, I84g50k59vdko9, I92o2mr60mvqni, I86kjcprqpmpbf, In7a38730s6qs, If15el53dd76v9, I9s0ave7t0vnrk, Ic6nglu2db2c36, I4q39t5hn830vp, I35p85j063s0il, I8ofcg5rbj0g2c, I4adgbll7gku4i, I6pjjpfvhvcfru, I9pj91mj79qekl, I39uah9nss64h9, Ik64dknsq7k08, Ib51vk42m1po4n, Idcr6u6361oad9, Ico5mjpqfgtpuj, I46s97719jsq03, I79cmnv5q6b3p, If1fboivengemn, Ibh0d53vr9icth, I2sr30isvv1i3a, I4ov6e94l79mbg, I4mq3ssndm1dbu, I45oruu1f0aihd, I80oivsrvtnpf1, I5vhombd5v3q3i, Ifn5slgv2scogq, I2sh1vq7mki6oa, I2vkf0rft09hc1, I87vll2k0a91o2, Iekaug5vo6n1jh, Ie54ng68f2kek5, I2cjplfh6m2djj, I7efm6ceeotvpk, I2ei6jes8e1vjr, Icquq3o4hcmj65, Ib98qbv23c0tst, Iebdnbvufodnev, I65i612een2ak, I5vvf47ira6s09, I5ns79ftlq8cnl, I59ofijoau4bjh, Ibmr18suc9ikh9, Ieka2e164ntfss, I5u8olqbbvfnvf, I5utcetro501ir, I5tnpomjhli8ea, I9fin09kkg0jaj, Iar76998r89ou1, Ichu6a94bm67kd, I666bl2fqjkejo, I1u3ac7lafvv5b, I5teebeg0opib2, I1moso5oagpiea, Ibeb4n9vpjefp3, Id7murq9s9fg6h, Ied9mja4bq7va8, I4f7jul8ljs54r, I1gk9fmne451rl, I2ev73t79f46tb, I1736r1jp6plpc, If31vrl50nund3, I6s1n1athh0bbq, I3v9h9f3mpm1l8, I9mnj4k4u8ls2c, I2kt2u1flctk2q, I38jfk5li8iang, If9uk9cppuuifi, I9q0ensvnonfmg, I2dtrijkm5601t, Ib2obgji960euh, Icviohnuu9eu8b, I780ptnqsedf69, Ict9ivhr2c5hv0, Ia5huiefjr1uhk, Iaa13icjlsj13d, I98vh5ccjtf1ev, I3al0eab2u0gt2, Ib3prtfc334m1t, I6fuug4i4r04hi, I31k9f0jol8ko4, I80q14um2s2ckg, I5qs1t1erfi7u8, I9et13knvdvgpb, Ifsme8miqq9006, I2eip8tc75dpje, I564va64vtidbq, Ie5v6njpckr05b, I328av3j0bgmjb, I4tuqm9ato907i, I19iomcbdrerea, I9dgmcnuamt5p8, I3vh014cqgmrfd, Ifhs60omlhvt3, If34udpd5e57vi, I39t01nnod9109, Ie5vbnd9198quk, I3h6murn8bd4v5, I6k6jf8ncesuu3, I6rqcpg80db1fb, If1qr0kbbl298c, Idl3umm12u5pa, I5ont0141q9ss5, Ie6j49utvii126, I3v6ks33uluhnj, I3kiiim1cds68i, I4k60mkh2r6jjg, I7b38nnt67hfdg, I7fcl4aua07ato, Icm9m0qeemu66d, Iff30ongi0pbsu, I2a839vbf5817q, Ia9p5bg6p18r0i, I5rlb1eesbovji, Ia96ru6pujbas0, I90n6nnkpdahrh, I8mk5kjgn02hi8, I5onpf3u0obsqb, I2gr10p66od9ch, I5d9an59q96b9e, Iepvl96j3rpblo, Iems2cb8v3lka8, I4oh0ds0hgt386, Ieg1oc56mamrl5, I2vu5vj7173ik9, Id70c5vciftf2i, I36uoc8t9liv80, I9iq45aekjq7kb, I26ne2mpnrbqa5, I9tlpr80ot76ta, I47a2tsd2o2b1c, Ifc9k1s0e9nv8e, I4ihj26hl75e5p, I2dl8ekhm2t22h, I13us5e5h5645o, I931cottvong90, Ic4h0nvtu79ch6, I1ors0vru14it3, I40s11r8nagn2g, I6bjj87fr5g9nl, I8cbluptqo8kbp, I6t5r359eagicn, I3ihan8icf0c5k, I7aouqn0g9m7gc, I8e7g876q3bfql, I229jvdlbdhm94, I9dm0i7fm6o3ac, Ifs1i5fk9cqvr6, I8687goclso3lb, Ids6rugsrrgf4d, Iihueknplcvov, Ifujo84eluf6dm, I1d9656ogitc3u, I82nfqfkd48n10, I1jm8m1rh9e20v, I3o5j3bli1pd8e, Iba7pefg0d11kh, I2pjehun5ehh5i, I49p1tgb1igk6, I73kffnn32g4c7, I2kds5jji7slh8, Ia9mkdf6l44shb, I9l2s4klu0831o, I2ctrt5nqb8o7c, I711qahikocb1c, Id6gojh30v9ib2, I9h4cqmadpj7l0, I29bkdd7n16li1, I9jb9hqm18runn, I85htvo8b885h, I95j99om5qfj06, Ifh75tbmlqktju, Ie5l999tf7t2te, I835br1ailr092, I4nknuetu70u1a, Idk4dmbj6bivjh, I4fhhc9mub7uo8, Ijlbhl3lcdb3d, I44imsiesapsp9, Icr6ao0t0ec3r6, Ia8ogbeici6lip, Idcabvplu05lea, I2ncccle6pmhd9, I92bnd3pe0civj, Ic84i538n8bl8j, I837c61fc07ine, I6v8kghkt0dksl, I7vi74gbubc8u5, I3u0knmtb1ueq7, Ialjbutpk9fktt, I6857skgbjgbj4, Ia2th0jtu8gpfn, I4fjuo0cog477g, I623bfqj2uih54, Idj9faf6hgsdur, I8mj1nm903hpts, I7an0d6j0oge8o, Ie08tvgm9uje9n, I39b902684r57b, I6ah8cnfnbkuqo, I94dejtmu6d72i, I2oet9jl0tboi4, Icimuh915fen06, Itdoblp90lfe2, If9sojp49tb7bn, I2i9ihlf6tlsua, I97hfovkaaqb7h, Ibqlvl2pb9t94e, I6367gk7n5srvv, I51q1ab7s5ros5, Icns9uu67sm2c, Ie3u49lcd7idld, Idjafbm59g1uqh, I9acqruh7322g2, I8o0n1n0sdpujr, Ibftam0unl1fsq, I7ckaemrn32ju, If5mnb2sshko5d, I8den9qn740oa7, I6h5nf3idmn898, Ifoap83itjns41, Ib1ilbm5ipoh62, I66r1tu4acmi8i, I8fe3c4k4rohtd, I5pjaoviin0m2, Ifdpca19a4andf, I1jjo47oaa4a7e, Ieijed8jf38v2, I3ldmjfqravo2c, I89s5nqb1ge1ue, Icbccs0ug47ilf, I6ep07oaf1eoa2, I9pf8ji3tn7abh, I1il5mj68vvsms, Ifqtvku7shnlle, I2rg5btjrsqec0, Id5fm4p8lj5qgi, I17do9d5rlq72d, Ib4e7k10isusrc, Iclo2qf5jhpbn0, I3qt1hgg4djhgb, I37gkv4ibak4u6, I6rufhqab68dv7, I5guamh56257sq, Ibie35o389u5m5, I4enrikluv7ukd, I7s3nv09agh2e2, I1f9io740eqir0, Iart6p0ogm1a4g, Ia6i01als4j5u5, Ial53v9g5go073, I5mdteph6cc9jt, Ifkr43tqovhaij, I91984ic727015, Iprdg004aleb1, I4j0crdbqua0qu, I26uip050ir8v7, I2unte8sl8u10d, Iakdoa23lufqg0, I6dgvurjgtiomb, I1oh4jsoq9jqr0, I95fuqbk5en8j6, Ib1oa5g7vc8nbc, I5632otb8qptv2, Ibffn022ev2pud, I8npm6laabqo83, I9946bspu783hd, I4ir6ck75pcou4, Ie4uqb22ums70, I6tepc53cpcgor, I7pmn74tpeupjh, I8q57m51quft2e, I1fm7b684mo0pb, Icsr8fi82ccpe5, Ifujvbrougmt1u, Ia82mnkmeo2rhc, I3ivcchssriktc, I855j4i3kr8ko1, I548nsjpe0eqli, I5rtkmhm2dng4u, I2f09r4lf5jjh9, If6m0o1bjubses, Ica4tsd7r045b4, I8lqcc9n1bpf10, Ic756ll6rev3et, Iabgjddlh1k1hp, Ie04jjjrr8q02l, Ib9karr24cpmca, Ifstva0urnm27g, I4lpo3encq7fn8, Icd1cghie6s8nr, I7vvm3he225ppt, Iaui349lsh3clk, Ifbddfv84nkppg, Iil3sdsh8fk7l, I85i3hdo5nsfi5, Ic65advfoqjhk7, Icv68aq8841478, Ic262ibdoec56a, Iflcfm9b6nlmdd, Ijrsf4mnp3eka, I8tjvj9uq4b7hi, I4cbvqmqadhrea, I4fooe9dun9o0t, Ier2cke86dqbr2, I5768ac424h061, Ia1u3jll6a06ae, I3peh714diura8, I62ffgu6q2478o, I10r7il4gvbcae, I5bb5d1095hgr4, Iet7kfijhihjik, I2vrbos7ogo6ps, Iffeo46j957abe, I4ljshcevmm3p2, Ift6f10887nk72, I7qc53b1tvqjg2, Ie4reroenbg6hl, Iak7fhrgb9jnnq, Ievr89968437gm, Iaofef34v2445a, Ie3gphha4ejh40, I4b66js88p45m8, I50d9r8lrdga93, I27avf13g71mla, I4mol6k10mv0io, Iec90vukseit9e, I7j4m7a3pkvsf4, Ie732teo48djnq, I1au3fq4n84nv3, Iejaj7m7qka9tr, Idnak900lt5lm8, I27n7lbd66730p, I2hq50pu2kdjpo, Ifk8eme5o7mukf, Iau4cgm6ih61cf, I6ir616rur362k, Ic19as7nbst738, I54umskavgc9du, I2ip7o9e2tc5sf, I5egvk6hadac5h, I8iksqi3eani0a, I16enopmju1p0q, I43kq8qudg7pq9, I76riseemre533, I38bmcrmh852rk, I4hcillge8de5f, I3pitp3nlr696e, Id9idaj83175f9, Ie1semicfuv5uu, If25fjs9o37co1, I70sc1pdo8vtos, I60p8l86a8cm59, I3m3sk2lgcabvp, I5pf572duh4oeg, I37454vatvmm1l, Iblau1qa7u7fet, I1ti389kf8t6oi, If4nnre373amul, I55kbor0ocqk6h, Idsj9cg7j96kpc, Ido4u9drncfaml, Ie8c7ctks8ur2p, I7vqogd77mmdlm, I6mik29s5073td, I2m0sqmb75cnpb, I49agc5b62mehu, Iatq9jda4hq6pg, I2g87evcjlgmqi, I4q514k7hotnla, I349gm6qoac50o, I4cdcnl6pft57b, Iempvdlhc5ih6g, I6niuoceqveh04, I311vp8270bfmr, Iep1lmt6q3s6r3, I1fac16213rie2, Ifjt77oc391o43, Itvt1jsipv0lc, Ick3mveut33f44, Ibdqerrooruuq9, Ifb1u4u75pnv4d, I7ieadb293k6b4, Iflou98pkqhgp1, Ieosut54dhd8pc, Ibguhqka712ouh, Iep27ialq4a7o7, I9pa9lkcl3m04m, I1g53hjmqmckm1, Ic9sq0g5877186, Iea4g5ovhnolus, Ifmc9boeeia623, Itmchvgqfl28g, Ica53a2fsmlu8g, I2ur0oeqg495j8, I71qkr273g0pbg, Iafscmv8tjf0ou, I95f1d94gdec1o, I9fblj87mudkiv, I5sa3bg1srbtcp, Idenpluu9g8b8j, Idrt2apfs11eis, I4q8er4unru0b9, I8sqgsmt3nkhst, Iu15sgmdgsi1p, I7v7gll3do8k87, I4etue4v1vop9d, I3p9almsc035kf, Ic8slrb9jkor44, Ic5b47dj4coa3r, I4pplpbc9ri87h, Idfddce516cam8, I4jk88c81fdpj7, Iblmvi7rns4hat, I1ncftf0dda44b, I4017m8vg7mg77, Ifbfri4ebdp100, Ia0ou717s993mj, I81ecksq9ft26q, Ifg11tc1e56rdc, Ib7rbng5pdr5s8, I3l0mkl2i9jnf2, Ibjfehbtn97bsa, I5spuldj7iqfb2, Iercff15akpdf4, I9vi4snjoo3h4b, Idsvjrg7b991is, Ie4intrc3n8jfu, I1etdvmasu1v94, Ib6f67cbu0ud37, I1kk4k738d2nd8, I2motmr03c9658, I88fot44bnslov, Ieci754e21flil, Id7sgl9r2a73an, I3vte5us4num84, I8vi912pe5tcr7, I7bn9n98cqhjfq, Ia6h3b4okf7ksl, I2pjn1un8imcq7, I1tckflje7cjv, Ib5s1ffmflb3qm, I99kjujp4cntp, I4tti5pllg262l, If0m30u84ipduc, If8q631vdal219, Iaqm07nd3jnjm3, I38bt9hnqlio44, I1udjuelukvhag, I1lhs3d4ekov9p, Ia2msbpam1cji1, Idu6bl8365ot38, I2k4l82jgghpug, Ic6k2eeen6ajgt, I8ri442nsb40lv, Ibnl9iu19ttf33, I3btqr02g3j6t5, I60f9q2drfiblu, Idb9q16jbip9cv, Id7emp2djki762, Idff3go57k37mm, Ie4guudbjqttqv, I7uk77lejof7mb, Idftouvduud2qb, Ifsg9bn8i41e00, I4u87dkg0ej74m, BagsListListListError, Ie2db4l6126rkt, I1e13lcoj2ijct, Idcpi3jpt0c03v, I2v50gu3s1aqk6, Iabpgqcjikia83, I4383lq801834t, If7uv525tdvv7a, I2an1fs2eiebjp, If08sfhqn8ujfr, Ic4rgfgksgmm3e, I3dj14b7k3rkm5, I8gq452h0p0ftu, If6glui021su7n, Ifogockjiq4b3, I2r0n4gcrs974b, Ie6kgk6f04rsvk, Ibkook56hopvp8, I1fl9qh2r1hf29, I4arjljr6dpflb, I45rl58hfs7m0h, I6fr2mqud652ga, TransactionValidityTransactionSource, Iajbob6uln5jct, Icerf8h8pdu8ss, Iems84l8lk2v0c, I1r5ke30ueqo0r, I55620scbn6g1k, I6spmpef2c7svf, Iei2mvq0mjvt81, Ifh2vvcsf9090p, I5stn0hvret66s, I7qoh20ucjt7ir, Ic42ukvpnbiepo, I9fkvk930p4vn2, I9mv67prtv3200, I7hmn6t6t2ehn9, Idn8l2092gsjnc, I7dv09hod9o9ng, I2q8ltoai1r4og, Ie9sr1iqcg3cgm, I1mqgk2tmnn9i2, I6lr8sctk0bi4e, Ik9f7r9ibbik9 } from "./common-types";
type AnonymousEnum<T extends {}> = T & {
    __anonymous: true;
};
type MyTuple<T> = [T, ...T[]];
type SeparateUndefined<T> = undefined extends T ? undefined | Exclude<T, undefined> : T;
type Anonymize<T> = SeparateUndefined<T extends FixedSizeBinary<infer L> ? number extends L ? Binary : FixedSizeBinary<L> : T extends string | number | bigint | boolean | void | undefined | null | symbol | Uint8Array | Enum<any> ? T : T extends AnonymousEnum<infer V> ? Enum<V> : T extends MyTuple<any> ? {
    [K in keyof T]: T[K];
} : T extends [] ? [] : T extends FixedSizeArray<infer L, infer T> ? number extends L ? Array<T> : FixedSizeArray<L, T> : {
    [K in keyof T & string]: T[K];
}>;
type IStorage = {
    System: {
        /**
         * The full account information for a particular account ID.
         */
        Account: StorageDescriptor<[Key: SS58String], Anonymize<I5sesotjlssv2d>, false, never>;
        /**
         * Total extrinsics count for the current block.
         */
        ExtrinsicCount: StorageDescriptor<[], number, true, never>;
        /**
         * Whether all inherents have been applied.
         */
        InherentsApplied: StorageDescriptor<[], boolean, false, never>;
        /**
         * The current weight for the block.
         */
        BlockWeight: StorageDescriptor<[], Anonymize<Iffmde3ekjedi9>, false, never>;
        /**
         * Total length (in bytes) for all extrinsics put together, for the current block.
         */
        AllExtrinsicsLen: StorageDescriptor<[], number, true, never>;
        /**
         * Map of block numbers to block hashes.
         */
        BlockHash: StorageDescriptor<[Key: bigint], FixedSizeBinary<32>, false, never>;
        /**
         * Extrinsics data for the current block (maps an extrinsic's index to its data).
         */
        ExtrinsicData: StorageDescriptor<[Key: number], Binary, false, never>;
        /**
         * The current block number being processed. Set by `execute_block`.
         */
        Number: StorageDescriptor<[], bigint, false, never>;
        /**
         * Hash of the previous block.
         */
        ParentHash: StorageDescriptor<[], FixedSizeBinary<32>, false, never>;
        /**
         * Digest of the current block, also part of the block header.
         */
        Digest: StorageDescriptor<[], Anonymize<I4mddgoa69c0a2>, false, never>;
        /**
         * Events deposited for the current block.
         *
         * NOTE: The item is unbound and should therefore never be read on chain.
         * It could otherwise inflate the PoV size of a block.
         *
         * Events have a large in-memory size. Box the events to not go out-of-memory
         * just in case someone still reads them from within the runtime.
         */
        Events: StorageDescriptor<[], Anonymize<Icp0d89tlsgb4c>, false, never>;
        /**
         * The number of events in the `Events<T>` list.
         */
        EventCount: StorageDescriptor<[], number, false, never>;
        /**
         * Mapping between a topic (represented by T::Hash) and a vector of indexes
         * of events in the `<Events<T>>` list.
         *
         * All topic vectors have deterministic storage locations depending on the topic. This
         * allows light-clients to leverage the changes trie storage tracking mechanism and
         * in case of changes fetch the list of events of interest.
         *
         * The value has the type `(BlockNumberFor<T>, EventIndex)` because if we used only just
         * the `EventIndex` then in case if the topic has the same contents on the next block
         * no notification will be triggered thus the event might be lost.
         */
        EventTopics: StorageDescriptor<[Key: FixedSizeBinary<32>], Anonymize<Ifip05kcrl65am>, false, never>;
        /**
         * Stores the `spec_version` and `spec_name` of when the last runtime upgrade happened.
         */
        LastRuntimeUpgrade: StorageDescriptor<[], Anonymize<Ieniouoqkq4icf>, true, never>;
        /**
         * True if we have upgraded so that `type RefCount` is `u32`. False (default) if not.
         */
        UpgradedToU32RefCount: StorageDescriptor<[], boolean, false, never>;
        /**
         * True if we have upgraded so that AccountInfo contains three types of `RefCount`. False
         * (default) if not.
         */
        UpgradedToTripleRefCount: StorageDescriptor<[], boolean, false, never>;
        /**
         * The execution phase of the block.
         */
        ExecutionPhase: StorageDescriptor<[], Phase, true, never>;
        /**
         * `Some` if a code upgrade has been authorized.
         */
        AuthorizedUpgrade: StorageDescriptor<[], Anonymize<Ibgl04rn6nbfm6>, true, never>;
    };
    Timestamp: {
        /**
         * The current time for the current block.
         */
        Now: StorageDescriptor<[], bigint, false, never>;
        /**
         * Whether the timestamp has been updated in this block.
         *
         * This value is updated to `true` upon successful submission of a timestamp by a node.
         * It is then checked at the end of each block execution in the `on_finalize` hook.
         */
        DidUpdate: StorageDescriptor<[], boolean, false, never>;
    };
    Sudo: {
        /**
         * The `AccountId` of the sudo key.
         */
        Key: StorageDescriptor<[], SS58String, true, never>;
    };
    RandomnessCollectiveFlip: {
        /**
         * Series of block headers from the last 81 blocks that acts as random seed material. This
         * is arranged as a ring buffer with `block_number % 81` being the index into the `Vec` of
         * the oldest hash.
         */
        RandomMaterial: StorageDescriptor<[], Anonymize<Ic5m5lp1oioo8r>, false, never>;
    };
    Assets: {
        /**
         * Details of an asset.
         */
        Asset: StorageDescriptor<[Key: bigint], Anonymize<I3qklfjubrljqh>, true, never>;
        /**
         * The holdings of a specific account for a specific asset.
         */
        Account: StorageDescriptor<Anonymize<I96rqo4i9p11oo>, Anonymize<Iag3f1hum3p4c8>, true, never>;
        /**
         * Approved balance transfers. First balance is the amount approved for transfer. Second
         * is the amount of `T::Currency` reserved for storing this.
         * First key is the asset ID, second key is the owner and third key is the delegate.
         */
        Approvals: StorageDescriptor<Anonymize<I6lsoh4c5um3u5>, Anonymize<I4s6jkha20aoh0>, true, never>;
        /**
         * Metadata of an asset.
         */
        Metadata: StorageDescriptor<[Key: bigint], Anonymize<I78s05f59eoi8b>, false, never>;
        /**
         * The asset ID enforced for the next asset creation, if any present. Otherwise, this storage
         * item has no effect.
         *
         * This can be useful for setting up constraints for IDs of the new assets. For example, by
         * providing an initial [`NextAssetId`] and using the [`crate::AutoIncAssetId`] callback, an
         * auto-increment model can be applied to all new asset IDs.
         *
         * The initial next asset ID can be set using the [`GenesisConfig`] or the
         * [SetNextAssetId](`migration::next_asset_id::SetNextAssetId`) migration.
         */
        NextAssetId: StorageDescriptor<[], bigint, true, never>;
    };
    Balances: {
        /**
         * The total units issued in the system.
         */
        TotalIssuance: StorageDescriptor<[], bigint, false, never>;
        /**
         * The total units of outstanding deactivated balance in the system.
         */
        InactiveIssuance: StorageDescriptor<[], bigint, false, never>;
        /**
         * The Balances pallet example of storing the balance of an account.
         *
         * # Example
         *
         * ```nocompile
         * impl pallet_balances::Config for Runtime {
         * type AccountStore = StorageMapShim<Self::Account<Runtime>, frame_system::Provider<Runtime>, AccountId, Self::AccountData<Balance>>
         * }
         * ```
         *
         * You can also store the balance of an account in the `System` pallet.
         *
         * # Example
         *
         * ```nocompile
         * impl pallet_balances::Config for Runtime {
         * type AccountStore = System
         * }
         * ```
         *
         * But this comes with tradeoffs, storing account balances in the system pallet stores
         * `frame_system` data alongside the account data contrary to storing account balances in the
         * `Balances` pallet, which uses a `StorageMap` to store balances data only.
         * NOTE: This is only used in the case that this pallet is used to store balances.
         */
        Account: StorageDescriptor<[Key: SS58String], Anonymize<I1q8tnt1cluu5j>, false, never>;
        /**
         * Any liquidity locks on some account balances.
         * NOTE: Should only be accessed when setting, changing and freeing a lock.
         *
         * Use of locks is deprecated in favour of freezes. See `https://github.com/paritytech/substrate/pull/12951/`
         */
        Locks: StorageDescriptor<[Key: SS58String], Anonymize<I8ds64oj6581v0>, false, never>;
        /**
         * Named reserves on some account balances.
         *
         * Use of reserves is deprecated in favour of holds. See `https://github.com/paritytech/substrate/pull/12951/`
         */
        Reserves: StorageDescriptor<[Key: SS58String], Anonymize<Ia7pdug7cdsg8g>, false, never>;
        /**
         * Holds on account balances.
         */
        Holds: StorageDescriptor<[Key: SS58String], Anonymize<Icg2f7lij7mhun>, false, never>;
        /**
         * Freeze locks on account balances.
         */
        Freezes: StorageDescriptor<[Key: SS58String], Anonymize<I2l1ctuihi2mfd>, false, never>;
    };
    TransactionPayment: {
        /**
        
         */
        NextFeeMultiplier: StorageDescriptor<[], bigint, false, never>;
        /**
        
         */
        StorageVersion: StorageDescriptor<[], TransactionPaymentReleases, false, never>;
    };
    Authorship: {
        /**
         * Author of current block.
         */
        Author: StorageDescriptor<[], SS58String, true, never>;
    };
    Babe: {
        /**
         * Current epoch index.
         */
        EpochIndex: StorageDescriptor<[], bigint, false, never>;
        /**
         * Current epoch authorities.
         */
        Authorities: StorageDescriptor<[], Anonymize<I3geksg000c171>, false, never>;
        /**
         * The slot at which the first epoch actually started. This is 0
         * until the first block of the chain.
         */
        GenesisSlot: StorageDescriptor<[], bigint, false, never>;
        /**
         * Current slot number.
         */
        CurrentSlot: StorageDescriptor<[], bigint, false, never>;
        /**
         * The epoch randomness for the *current* epoch.
         *
         * # Security
         *
         * This MUST NOT be used for gambling, as it can be influenced by a
         * malicious validator in the short term. It MAY be used in many
         * cryptographic protocols, however, so long as one remembers that this
         * (like everything else on-chain) it is public. For example, it can be
         * used where a number is needed that cannot have been chosen by an
         * adversary, for purposes such as public-coin zero-knowledge proofs.
         */
        Randomness: StorageDescriptor<[], FixedSizeBinary<32>, false, never>;
        /**
         * Pending epoch configuration change that will be applied when the next epoch is enacted.
         */
        PendingEpochConfigChange: StorageDescriptor<[], BabeDigestsNextConfigDescriptor, true, never>;
        /**
         * Next epoch randomness.
         */
        NextRandomness: StorageDescriptor<[], FixedSizeBinary<32>, false, never>;
        /**
         * Next epoch authorities.
         */
        NextAuthorities: StorageDescriptor<[], Anonymize<I3geksg000c171>, false, never>;
        /**
         * Randomness under construction.
         *
         * We make a trade-off between storage accesses and list length.
         * We store the under-construction randomness in segments of up to
         * `UNDER_CONSTRUCTION_SEGMENT_LENGTH`.
         *
         * Once a segment reaches this length, we begin the next one.
         * We reset all segments and return to `0` at the beginning of every
         * epoch.
         */
        SegmentIndex: StorageDescriptor<[], number, false, never>;
        /**
         * TWOX-NOTE: `SegmentIndex` is an increasing integer, so this is okay.
         */
        UnderConstruction: StorageDescriptor<[Key: number], Anonymize<Ic5m5lp1oioo8r>, false, never>;
        /**
         * Temporary value (cleared at block finalization) which is `Some`
         * if per-block initialization has already been called for current block.
         */
        Initialized: StorageDescriptor<[], Anonymize<Idq7or56ds2f13>, true, never>;
        /**
         * This field should always be populated during block processing unless
         * secondary plain slots are enabled (which don't contain a VRF output).
         *
         * It is set in `on_finalize`, before it will contain the value from the last block.
         */
        AuthorVrfRandomness: StorageDescriptor<[], Anonymize<I4s6vifaf8k998>, false, never>;
        /**
         * The block numbers when the last and current epoch have started, respectively `N-1` and
         * `N`.
         * NOTE: We track this is in order to annotate the block number when a given pool of
         * entropy was fixed (i.e. it was known to chain observers). Since epochs are defined in
         * slots, which may be skipped, the block numbers may not line up with the slot numbers.
         */
        EpochStart: StorageDescriptor<[], Anonymize<I200n1ov5tbcvr>, false, never>;
        /**
         * How late the current block is compared to its parent.
         *
         * This entry is populated as part of block execution and is cleaned up
         * on block finalization. Querying this storage entry outside of block
         * execution context should always yield zero.
         */
        Lateness: StorageDescriptor<[], bigint, false, never>;
        /**
         * The configuration for the current epoch. Should never be `None` as it is initialized in
         * genesis.
         */
        EpochConfig: StorageDescriptor<[], Anonymize<I8jnd4d8ip6djo>, true, never>;
        /**
         * The configuration for the next epoch, `None` if the config will not change
         * (you can fallback to `EpochConfig` instead in that case).
         */
        NextEpochConfig: StorageDescriptor<[], Anonymize<I8jnd4d8ip6djo>, true, never>;
        /**
         * A list of the last 100 skipped epochs and the corresponding session index
         * when the epoch was skipped.
         *
         * This is only used for validating equivocation proofs. An equivocation proof
         * must contains a key-ownership proof for a given session, therefore we need a
         * way to tie together sessions and epoch indices, i.e. we need to validate that
         * a validator was the owner of a given key on a given session, and what the
         * active epoch index was during that session.
         */
        SkippedEpochs: StorageDescriptor<[], Anonymize<Ifip05kcrl65am>, false, never>;
    };
    Grandpa: {
        /**
         * State of the current authority set.
         */
        State: StorageDescriptor<[], Anonymize<Ia24s7cuas271t>, false, never>;
        /**
         * Pending change: (signaled at, scheduled change).
         */
        PendingChange: StorageDescriptor<[], Anonymize<I30cqmm2kaidet>, true, never>;
        /**
         * next block number where we can force a change.
         */
        NextForced: StorageDescriptor<[], bigint, true, never>;
        /**
         * `true` if we are currently stalled.
         */
        Stalled: StorageDescriptor<[], Anonymize<I200n1ov5tbcvr>, true, never>;
        /**
         * The number of changes (both in terms of keys and underlying economic responsibilities)
         * in the "set" of Grandpa validators from genesis.
         */
        CurrentSetId: StorageDescriptor<[], bigint, false, never>;
        /**
         * A mapping from grandpa set ID to the index of the *most recent* session for which its
         * members were responsible.
         *
         * This is only used for validating equivocation proofs. An equivocation proof must
         * contains a key-ownership proof for a given session, therefore we need a way to tie
         * together sessions and GRANDPA set ids, i.e. we need to validate that a validator
         * was the owner of a given key on a given session, and what the active set ID was
         * during that session.
         *
         * TWOX-NOTE: `SetId` is not under user control.
         */
        SetIdSession: StorageDescriptor<[Key: bigint], number, true, never>;
        /**
         * The current list of authorities.
         */
        Authorities: StorageDescriptor<[], Anonymize<I3geksg000c171>, false, never>;
    };
    Indices: {
        /**
         * The lookup from index to account.
         */
        Accounts: StorageDescriptor<[Key: number], Anonymize<Iff9heri56m1mb>, true, never>;
    };
    Democracy: {
        /**
         * The number of (public) proposals that have been made so far.
         */
        PublicPropCount: StorageDescriptor<[], number, false, never>;
        /**
         * The public proposals. Unsorted. The second item is the proposal.
         */
        PublicProps: StorageDescriptor<[], Anonymize<I6mhebgj62g585>, false, never>;
        /**
         * Those who have locked a deposit.
         *
         * TWOX-NOTE: Safe, as increasing integer keys are safe.
         */
        DepositOf: StorageDescriptor<[Key: number], Anonymize<I3vhcedhm4hpvm>, true, never>;
        /**
         * The next free referendum index, aka the number of referenda started so far.
         */
        ReferendumCount: StorageDescriptor<[], number, false, never>;
        /**
         * The lowest referendum index representing an unbaked referendum. Equal to
         * `ReferendumCount` if there isn't a unbaked referendum.
         */
        LowestUnbaked: StorageDescriptor<[], number, false, never>;
        /**
         * Information concerning any given referendum.
         *
         * TWOX-NOTE: SAFE as indexes are not under an attacker’s control.
         */
        ReferendumInfoOf: StorageDescriptor<[Key: number], Anonymize<Ianoje3qpmo6md>, true, never>;
        /**
         * All votes for a particular voter. We store the balance for the number of votes that we
         * have recorded. The second item is the total amount of delegations, that will be added.
         *
         * TWOX-NOTE: SAFE as `AccountId`s are crypto hashes anyway.
         */
        VotingOf: StorageDescriptor<[Key: SS58String], Anonymize<Ia3t44vpf24cgg>, false, never>;
        /**
         * True if the last referendum tabled was submitted externally. False if it was a public
         * proposal.
         */
        LastTabledWasExternal: StorageDescriptor<[], boolean, false, never>;
        /**
         * The referendum to be tabled whenever it would be valid to table an external proposal.
         * This happens when a referendum needs to be tabled and one of two conditions are met:
         * - `LastTabledWasExternal` is `false`; or
         * - `PublicProps` is empty.
         */
        NextExternal: StorageDescriptor<[], Anonymize<I5rsgtofmn5lli>, true, never>;
        /**
         * A record of who vetoed what. Maps proposal hash to a possible existent block number
         * (until when it may not be resubmitted) and who vetoed it.
         */
        Blacklist: StorageDescriptor<[Key: FixedSizeBinary<32>], Anonymize<I4nfjdef0ibh44>, true, never>;
        /**
         * Record of all proposals that have been subject to emergency cancellation.
         */
        Cancellations: StorageDescriptor<[Key: FixedSizeBinary<32>], boolean, false, never>;
        /**
         * General information concerning any proposal or referendum.
         * The `Hash` refers to the preimage of the `Preimages` provider which can be a JSON
         * dump or IPFS hash of a JSON file.
         *
         * Consider a garbage collection for a metadata of finished referendums to `unrequest` (remove)
         * large preimages.
         */
        MetadataOf: StorageDescriptor<[Key: Anonymize<I2itl2k1j2q8nf>], FixedSizeBinary<32>, true, never>;
    };
    Council: {
        /**
         * The hashes of the active proposals.
         */
        Proposals: StorageDescriptor<[], Anonymize<Ic5m5lp1oioo8r>, false, never>;
        /**
         * Actual proposal for a given hash, if it's current.
         */
        ProposalOf: StorageDescriptor<[Key: FixedSizeBinary<32>], Anonymize<If4gigsesqmr49>, true, never>;
        /**
         * Votes on a given proposal, if it is ongoing.
         */
        Voting: StorageDescriptor<[Key: FixedSizeBinary<32>], Anonymize<I8g8u2r2m659dq>, true, never>;
        /**
         * Proposals so far.
         */
        ProposalCount: StorageDescriptor<[], number, false, never>;
        /**
         * The current members of the collective. This is stored sorted (just by value).
         */
        Members: StorageDescriptor<[], Anonymize<Ia2lhg7l2hilo3>, false, never>;
        /**
         * The prime member that helps determine the default vote behavior in case of abstentions.
         */
        Prime: StorageDescriptor<[], SS58String, true, never>;
    };
    Vesting: {
        /**
         * Information regarding the vesting of a given account.
         */
        Vesting: StorageDescriptor<[Key: SS58String], Anonymize<I63js2b08d3e38>, true, never>;
        /**
         * Storage version of the pallet.
         *
         * New networks start with latest version, as determined by the genesis build.
         */
        StorageVersion: StorageDescriptor<[], Version, false, never>;
    };
    Elections: {
        /**
         * The current elected members.
         *
         * Invariant: Always sorted based on account id.
         */
        Members: StorageDescriptor<[], Anonymize<I8nj9dlo7lnbb3>, false, never>;
        /**
         * The current reserved runners-up.
         *
         * Invariant: Always sorted based on rank (worse to best). Upon removal of a member, the
         * last (i.e. _best_) runner-up will be replaced.
         */
        RunnersUp: StorageDescriptor<[], Anonymize<I8nj9dlo7lnbb3>, false, never>;
        /**
         * The present candidate list. A current member or runner-up can never enter this vector
         * and is always implicitly assumed to be a candidate.
         *
         * Second element is the deposit.
         *
         * Invariant: Always sorted based on account id.
         */
        Candidates: StorageDescriptor<[], Anonymize<Iba9inugg1atvo>, false, never>;
        /**
         * The total number of vote rounds that have happened, excluding the upcoming one.
         */
        ElectionRounds: StorageDescriptor<[], number, false, never>;
        /**
         * Votes and locked stake of a particular voter.
         *
         * TWOX-NOTE: SAFE as `AccountId` is a crypto hash.
         */
        Voting: StorageDescriptor<[Key: SS58String], Anonymize<Ib23vkkc52tqbu>, false, never>;
    };
    ElectionProviderMultiPhase: {
        /**
         * Internal counter for the number of rounds.
         *
         * This is useful for de-duplication of transactions submitted to the pool, and general
         * diagnostics of the pallet.
         *
         * This is merely incremented once per every time that an upstream `elect` is called.
         */
        Round: StorageDescriptor<[], number, false, never>;
        /**
         * Current phase.
         */
        CurrentPhase: StorageDescriptor<[], Anonymize<I60mqgbf0p40e1>, false, never>;
        /**
         * Current best solution, signed or unsigned, queued to be returned upon `elect`.
         *
         * Always sorted by score.
         */
        QueuedSolution: StorageDescriptor<[], Anonymize<Ictkaqdbfabuek>, true, never>;
        /**
         * Snapshot data of the round.
         *
         * This is created at the beginning of the signed phase and cleared upon calling `elect`.
         * Note: This storage type must only be mutated through [`SnapshotWrapper`].
         */
        Snapshot: StorageDescriptor<[], Anonymize<Ia7o65280hur3p>, true, never>;
        /**
         * Desired number of targets to elect for this round.
         *
         * Only exists when [`Snapshot`] is present.
         * Note: This storage type must only be mutated through [`SnapshotWrapper`].
         */
        DesiredTargets: StorageDescriptor<[], number, true, never>;
        /**
         * The metadata of the [`RoundSnapshot`]
         *
         * Only exists when [`Snapshot`] is present.
         * Note: This storage type must only be mutated through [`SnapshotWrapper`].
         */
        SnapshotMetadata: StorageDescriptor<[], Anonymize<Iasd2iat48n080>, true, never>;
        /**
         * The next index to be assigned to an incoming signed submission.
         *
         * Every accepted submission is assigned a unique index; that index is bound to that particular
         * submission for the duration of the election. On election finalization, the next index is
         * reset to 0.
         *
         * We can't just use `SignedSubmissionIndices.len()`, because that's a bounded set; past its
         * capacity, it will simply saturate. We can't just iterate over `SignedSubmissionsMap`,
         * because iteration is slow. Instead, we store the value here.
         */
        SignedSubmissionNextIndex: StorageDescriptor<[], number, false, never>;
        /**
         * A sorted, bounded vector of `(score, block_number, index)`, where each `index` points to a
         * value in `SignedSubmissions`.
         *
         * We never need to process more than a single signed submission at a time. Signed submissions
         * can be quite large, so we're willing to pay the cost of multiple database accesses to access
         * them one at a time instead of reading and decoding all of them at once.
         */
        SignedSubmissionIndices: StorageDescriptor<[], Anonymize<I41gemnici26aj>, false, never>;
        /**
         * Unchecked, signed solutions.
         *
         * Together with `SubmissionIndices`, this stores a bounded set of `SignedSubmissions` while
         * allowing us to keep only a single one in memory at a time.
         *
         * Twox note: the key of the map is an auto-incrementing index which users cannot inspect or
         * affect; we shouldn't need a cryptographically secure hasher.
         */
        SignedSubmissionsMap: StorageDescriptor<[Key: number], Anonymize<Irl37q7erstrb>, true, never>;
        /**
         * The minimum score that each 'untrusted' solution must attain in order to be considered
         * feasible.
         *
         * Can be set via `set_minimum_untrusted_score`.
         */
        MinimumUntrustedScore: StorageDescriptor<[], Anonymize<I8s6n43okuj2b1>, true, never>;
    };
    Staking: {
        /**
         * The ideal number of active validators.
         */
        ValidatorCount: StorageDescriptor<[], number, false, never>;
        /**
         * Minimum number of staking participants before emergency conditions are imposed.
         */
        MinimumValidatorCount: StorageDescriptor<[], number, false, never>;
        /**
         * Any validators that may never be slashed or forcibly kicked. It's a Vec since they're
         * easy to initialize and the performance hit is minimal (we expect no more than four
         * invulnerables) and restricted to mainnets.
         */
        Invulnerables: StorageDescriptor<[], Anonymize<Ia2lhg7l2hilo3>, false, never>;
        /**
         * Map from all locked "stash" accounts to the controller account.
         *
         * TWOX-NOTE: SAFE since `AccountId` is a secure hash.
         */
        Bonded: StorageDescriptor<[Key: SS58String], SS58String, true, never>;
        /**
         * The minimum active bond to become and maintain the role of a nominator.
         */
        MinNominatorBond: StorageDescriptor<[], bigint, false, never>;
        /**
         * The minimum active bond to become and maintain the role of a validator.
         */
        MinValidatorBond: StorageDescriptor<[], bigint, false, never>;
        /**
         * The minimum active nominator stake of the last successful election.
         */
        MinimumActiveStake: StorageDescriptor<[], bigint, false, never>;
        /**
         * The minimum amount of commission that validators can set.
         *
         * If set to `0`, no limit exists.
         */
        MinCommission: StorageDescriptor<[], number, false, never>;
        /**
         * Map from all (unlocked) "controller" accounts to the info regarding the staking.
         *
         * Note: All the reads and mutations to this storage *MUST* be done through the methods exposed
         * by [`StakingLedger`] to ensure data and lock consistency.
         */
        Ledger: StorageDescriptor<[Key: SS58String], Anonymize<Ic12aht5vh2sen>, true, never>;
        /**
         * Where the reward payment should be made. Keyed by stash.
         *
         * TWOX-NOTE: SAFE since `AccountId` is a secure hash.
         */
        Payee: StorageDescriptor<[Key: SS58String], StakingRewardDestination, true, never>;
        /**
         * The map from (wannabe) validator stash key to the preferences of that validator.
         *
         * TWOX-NOTE: SAFE since `AccountId` is a secure hash.
         */
        Validators: StorageDescriptor<[Key: SS58String], Anonymize<I9o7ssi9vmhmgr>, false, never>;
        /**
         * Counter for the related counted storage map
         */
        CounterForValidators: StorageDescriptor<[], number, false, never>;
        /**
         * The maximum validator count before we stop allowing new validators to join.
         *
         * When this value is not set, no limits are enforced.
         */
        MaxValidatorsCount: StorageDescriptor<[], number, true, never>;
        /**
         * The map from nominator stash key to their nomination preferences, namely the validators that
         * they wish to support.
         *
         * Note that the keys of this storage map might become non-decodable in case the
         * account's [`NominationsQuota::MaxNominations`] configuration is decreased.
         * In this rare case, these nominators
         * are still existent in storage, their key is correct and retrievable (i.e. `contains_key`
         * indicates that they exist), but their value cannot be decoded. Therefore, the non-decodable
         * nominators will effectively not-exist, until they re-submit their preferences such that it
         * is within the bounds of the newly set `Config::MaxNominations`.
         *
         * This implies that `::iter_keys().count()` and `::iter().count()` might return different
         * values for this map. Moreover, the main `::count()` is aligned with the former, namely the
         * number of keys that exist.
         *
         * Lastly, if any of the nominators become non-decodable, they can be chilled immediately via
         * [`Call::chill_other`] dispatchable by anyone.
         *
         * TWOX-NOTE: SAFE since `AccountId` is a secure hash.
         */
        Nominators: StorageDescriptor<[Key: SS58String], Anonymize<Ic3m9d6tdl6gi2>, true, never>;
        /**
         * Counter for the related counted storage map
         */
        CounterForNominators: StorageDescriptor<[], number, false, never>;
        /**
         * Stakers whose funds are managed by other pallets.
         *
         * This pallet does not apply any locks on them, therefore they are only virtually bonded. They
         * are expected to be keyless accounts and hence should not be allowed to mutate their ledger
         * directly via this pallet. Instead, these accounts are managed by other pallets and accessed
         * via low level apis. We keep track of them to do minimal integrity checks.
         */
        VirtualStakers: StorageDescriptor<[Key: SS58String], null, true, never>;
        /**
         * Counter for the related counted storage map
         */
        CounterForVirtualStakers: StorageDescriptor<[], number, false, never>;
        /**
         * The maximum nominator count before we stop allowing new validators to join.
         *
         * When this value is not set, no limits are enforced.
         */
        MaxNominatorsCount: StorageDescriptor<[], number, true, never>;
        /**
         * The current era index.
         *
         * This is the latest planned era, depending on how the Session pallet queues the validator
         * set, it might be active or not.
         */
        CurrentEra: StorageDescriptor<[], number, true, never>;
        /**
         * The active era information, it holds index and start.
         *
         * The active era is the era being currently rewarded. Validator set of this era must be
         * equal to [`SessionInterface::validators`].
         */
        ActiveEra: StorageDescriptor<[], Anonymize<Ib3j7gb0jgs38u>, true, never>;
        /**
         * The session index at which the era start for the last [`Config::HistoryDepth`] eras.
         *
         * Note: This tracks the starting session (i.e. session index when era start being active)
         * for the eras in `[CurrentEra - HISTORY_DEPTH, CurrentEra]`.
         */
        ErasStartSessionIndex: StorageDescriptor<[Key: number], number, true, never>;
        /**
         * Exposure of validator at era.
         *
         * This is keyed first by the era index to allow bulk deletion and then the stash account.
         *
         * Is it removed after [`Config::HistoryDepth`] eras.
         * If stakers hasn't been set or has been removed then empty exposure is returned.
         *
         * Note: Deprecated since v14. Use `EraInfo` instead to work with exposures.
         */
        ErasStakers: StorageDescriptor<Anonymize<I7svnfko10tq2e>, Anonymize<Ifekshcrgkl12g>, false, never>;
        /**
         * Summary of validator exposure at a given era.
         *
         * This contains the total stake in support of the validator and their own stake. In addition,
         * it can also be used to get the number of nominators backing this validator and the number of
         * exposure pages they are divided into. The page count is useful to determine the number of
         * pages of rewards that needs to be claimed.
         *
         * This is keyed first by the era index to allow bulk deletion and then the stash account.
         * Should only be accessed through `EraInfo`.
         *
         * Is it removed after [`Config::HistoryDepth`] eras.
         * If stakers hasn't been set or has been removed then empty overview is returned.
         */
        ErasStakersOverview: StorageDescriptor<Anonymize<I7svnfko10tq2e>, Anonymize<I6flrronqs3l6n>, true, never>;
        /**
         * Clipped Exposure of validator at era.
         *
         * Note: This is deprecated, should be used as read-only and will be removed in the future.
         * New `Exposure`s are stored in a paged manner in `ErasStakersPaged` instead.
         *
         * This is similar to [`ErasStakers`] but number of nominators exposed is reduced to the
         * `T::MaxExposurePageSize` biggest stakers.
         * (Note: the field `total` and `own` of the exposure remains unchanged).
         * This is used to limit the i/o cost for the nominator payout.
         *
         * This is keyed fist by the era index to allow bulk deletion and then the stash account.
         *
         * It is removed after [`Config::HistoryDepth`] eras.
         * If stakers hasn't been set or has been removed then empty exposure is returned.
         *
         * Note: Deprecated since v14. Use `EraInfo` instead to work with exposures.
         */
        ErasStakersClipped: StorageDescriptor<Anonymize<I7svnfko10tq2e>, Anonymize<Ifekshcrgkl12g>, false, never>;
        /**
         * Paginated exposure of a validator at given era.
         *
         * This is keyed first by the era index to allow bulk deletion, then stash account and finally
         * the page. Should only be accessed through `EraInfo`.
         *
         * This is cleared after [`Config::HistoryDepth`] eras.
         */
        ErasStakersPaged: StorageDescriptor<Anonymize<Ia8896dq44k9m4>, Anonymize<I97fulj5h3ik95>, true, never>;
        /**
         * History of claimed paged rewards by era and validator.
         *
         * This is keyed by era and validator stash which maps to the set of page indexes which have
         * been claimed.
         *
         * It is removed after [`Config::HistoryDepth`] eras.
         */
        ClaimedRewards: StorageDescriptor<Anonymize<I7svnfko10tq2e>, Anonymize<Icgljjb6j82uhn>, false, never>;
        /**
         * Similar to `ErasStakers`, this holds the preferences of validators.
         *
         * This is keyed first by the era index to allow bulk deletion and then the stash account.
         *
         * Is it removed after [`Config::HistoryDepth`] eras.
         */
        ErasValidatorPrefs: StorageDescriptor<Anonymize<I7svnfko10tq2e>, Anonymize<I9o7ssi9vmhmgr>, false, never>;
        /**
         * The total validator era payout for the last [`Config::HistoryDepth`] eras.
         *
         * Eras that haven't finished yet or has been removed doesn't have reward.
         */
        ErasValidatorReward: StorageDescriptor<[Key: number], bigint, true, never>;
        /**
         * Rewards for the last [`Config::HistoryDepth`] eras.
         * If reward hasn't been set or has been removed then 0 reward is returned.
         */
        ErasRewardPoints: StorageDescriptor<[Key: number], Anonymize<Iff9p3c7k6pfoi>, false, never>;
        /**
         * The total amount staked for the last [`Config::HistoryDepth`] eras.
         * If total hasn't been set or has been removed then 0 stake is returned.
         */
        ErasTotalStake: StorageDescriptor<[Key: number], bigint, false, never>;
        /**
         * Mode of era forcing.
         */
        ForceEra: StorageDescriptor<[], StakingForcing, false, never>;
        /**
         * Maximum staked rewards, i.e. the percentage of the era inflation that
         * is used for stake rewards.
         * See [Era payout](./index.html#era-payout).
         */
        MaxStakedRewards: StorageDescriptor<[], number, true, never>;
        /**
         * The percentage of the slash that is distributed to reporters.
         *
         * The rest of the slashed value is handled by the `Slash`.
         */
        SlashRewardFraction: StorageDescriptor<[], number, false, never>;
        /**
         * The amount of currency given to reporters of a slash event which was
         * canceled by extraordinary circumstances (e.g. governance).
         */
        CanceledSlashPayout: StorageDescriptor<[], bigint, false, never>;
        /**
         * All unapplied slashes that are queued for later.
         */
        UnappliedSlashes: StorageDescriptor<[Key: number], Anonymize<Iafq6t4rgheait>, false, never>;
        /**
         * A mapping from still-bonded eras to the first session index of that era.
         *
         * Must contains information for eras for the range:
         * `[active_era - bounding_duration; active_era]`
         */
        BondedEras: StorageDescriptor<[], Anonymize<I95g6i7ilua7lq>, false, never>;
        /**
         * All slashing events on validators, mapped by era to the highest slash proportion
         * and slash value of the era.
         */
        ValidatorSlashInEra: StorageDescriptor<Anonymize<I7svnfko10tq2e>, Anonymize<I4ojmnsk1dchql>, true, never>;
        /**
         * All slashing events on nominators, mapped by era to the highest slash value of the era.
         */
        NominatorSlashInEra: StorageDescriptor<Anonymize<I7svnfko10tq2e>, bigint, true, never>;
        /**
         * Slashing spans for stash accounts.
         */
        SlashingSpans: StorageDescriptor<[Key: SS58String], Anonymize<Iinkhfdlka9ch>, true, never>;
        /**
         * Records information about the maximum slash of a stash within a slashing span,
         * as well as how much reward has been paid out.
         */
        SpanSlash: StorageDescriptor<[Key: Anonymize<I6ouflveob4eli>], Anonymize<I2kj4j6mp68hf8>, false, never>;
        /**
         * The last planned session scheduled by the session pallet.
         *
         * This is basically in sync with the call to [`pallet_session::SessionManager::new_session`].
         */
        CurrentPlannedSession: StorageDescriptor<[], number, false, never>;
        /**
         * Indices of validators that have offended in the active era. The offenders are disabled for a
         * whole era. For this reason they are kept here - only staking pallet knows about eras. The
         * implementor of [`DisablingStrategy`] defines if a validator should be disabled which
         * implicitly means that the implementor also controls the max number of disabled validators.
         *
         * The vec is always kept sorted so that we can find whether a given validator has previously
         * offended using binary search.
         */
        DisabledValidators: StorageDescriptor<[], Anonymize<Icgljjb6j82uhn>, false, never>;
        /**
         * The threshold for when users can start calling `chill_other` for other validators /
         * nominators. The threshold is compared to the actual number of validators / nominators
         * (`CountFor*`) in the system compared to the configured max (`Max*Count`).
         */
        ChillThreshold: StorageDescriptor<[], number, true, never>;
    };
    Session: {
        /**
         * The current set of validators.
         */
        Validators: StorageDescriptor<[], Anonymize<Ia2lhg7l2hilo3>, false, never>;
        /**
         * Current index of the session.
         */
        CurrentIndex: StorageDescriptor<[], number, false, never>;
        /**
         * True if the underlying economic identities or weighting behind the validators
         * has changed in the queued validator set.
         */
        QueuedChanged: StorageDescriptor<[], boolean, false, never>;
        /**
         * The queued keys for the next session. When the next session begins, these keys
         * will be used to determine the validator's session keys.
         */
        QueuedKeys: StorageDescriptor<[], Anonymize<I3n8u7haiacr3o>, false, never>;
        /**
         * Indices of disabled validators.
         *
         * The vec is always kept sorted so that we can find whether a given validator is
         * disabled using binary search. It gets cleared when `on_session_ending` returns
         * a new set of identities.
         */
        DisabledValidators: StorageDescriptor<[], Anonymize<Icgljjb6j82uhn>, false, never>;
        /**
         * The next session keys for a validator.
         */
        NextKeys: StorageDescriptor<[Key: SS58String], Anonymize<Ifngji0jpcpvpj>, true, never>;
        /**
         * The owner of a key. The key is the `KeyTypeId` + the encoded key.
         */
        KeyOwner: StorageDescriptor<[Key: Anonymize<I82jm9g7pufuel>], SS58String, true, never>;
    };
    Historical: {
        /**
         * Mapping from historical session indices to session-data root hash and validator count.
         */
        HistoricalSessions: StorageDescriptor<[Key: number], Anonymize<I4pact7n2e9a0i>, true, never>;
        /**
         * The range of historical sessions we store. [first, last)
         */
        StoredRange: StorageDescriptor<[], Anonymize<I9jd27rnpm8ttv>, true, never>;
    };
    Treasury: {
        /**
         * Number of proposals that have been made.
         */
        ProposalCount: StorageDescriptor<[], number, false, never>;
        /**
         * Proposals that have been made.
         */
        Proposals: StorageDescriptor<[Key: number], Anonymize<Iegmj7n48sc3am>, true, never>;
        /**
         * The amount which has been reported as inactive to Currency.
         */
        Deactivated: StorageDescriptor<[], bigint, false, never>;
        /**
         * Proposal indices that have been approved but not yet awarded.
         */
        Approvals: StorageDescriptor<[], Anonymize<Icgljjb6j82uhn>, false, never>;
        /**
         * The count of spends that have been made.
         */
        SpendCount: StorageDescriptor<[], number, false, never>;
        /**
         * Spends that have been approved and being processed.
         */
        Spends: StorageDescriptor<[Key: number], Anonymize<I3t96o5lsq581r>, true, never>;
    };
    Bounties: {
        /**
         * Number of bounty proposals that have been made.
         */
        BountyCount: StorageDescriptor<[], number, false, never>;
        /**
         * Bounties that have been made.
         */
        Bounties: StorageDescriptor<[Key: number], Anonymize<I17lk5gd4jui0r>, true, never>;
        /**
         * The description of each bounty.
         */
        BountyDescriptions: StorageDescriptor<[Key: number], Binary, true, never>;
        /**
         * Bounty indices that have been approved but not yet funded.
         */
        BountyApprovals: StorageDescriptor<[], Anonymize<Icgljjb6j82uhn>, false, never>;
    };
    ChildBounties: {
        /**
         * Number of total child bounties.
         */
        ChildBountyCount: StorageDescriptor<[], number, false, never>;
        /**
         * Number of child bounties per parent bounty.
         * Map of parent bounty index to number of child bounties.
         */
        ParentChildBounties: StorageDescriptor<[Key: number], number, false, never>;
        /**
         * Child bounties that have been added.
         */
        ChildBounties: StorageDescriptor<Anonymize<I9jd27rnpm8ttv>, Anonymize<I2ejqo0lr36e3q>, true, never>;
        /**
         * The description of each child-bounty.
         */
        ChildBountyDescriptions: StorageDescriptor<[Key: number], Binary, true, never>;
        /**
         * The cumulative child-bounty curator fee for each parent bounty.
         */
        ChildrenCuratorFees: StorageDescriptor<[Key: number], bigint, false, never>;
    };
    BagsList: {
        /**
         * A single node, within some bag.
         *
         * Nodes store links forward and back within their respective bags.
         */
        ListNodes: StorageDescriptor<[Key: SS58String], Anonymize<Ic5t26f9cp3tvk>, true, never>;
        /**
         * Counter for the related counted storage map
         */
        CounterForListNodes: StorageDescriptor<[], number, false, never>;
        /**
         * A bag stored in storage.
         *
         * Stores a `Bag` struct, which stores head and tail pointers to itself.
         */
        ListBags: StorageDescriptor<[Key: bigint], Anonymize<I39k39h6vu4hbq>, true, never>;
    };
    NominationPools: {
        /**
         * The sum of funds across all pools.
         *
         * This might be lower but never higher than the sum of `total_balance` of all [`PoolMembers`]
         * because calling `pool_withdraw_unbonded` might decrease the total stake of the pool's
         * `bonded_account` without adjusting the pallet-internal `UnbondingPool`'s.
         */
        TotalValueLocked: StorageDescriptor<[], bigint, false, never>;
        /**
         * Minimum amount to bond to join a pool.
         */
        MinJoinBond: StorageDescriptor<[], bigint, false, never>;
        /**
         * Minimum bond required to create a pool.
         *
         * This is the amount that the depositor must put as their initial stake in the pool, as an
         * indication of "skin in the game".
         *
         * This is the value that will always exist in the staking ledger of the pool bonded account
         * while all other accounts leave.
         */
        MinCreateBond: StorageDescriptor<[], bigint, false, never>;
        /**
         * Maximum number of nomination pools that can exist. If `None`, then an unbounded number of
         * pools can exist.
         */
        MaxPools: StorageDescriptor<[], number, true, never>;
        /**
         * Maximum number of members that can exist in the system. If `None`, then the count
         * members are not bound on a system wide basis.
         */
        MaxPoolMembers: StorageDescriptor<[], number, true, never>;
        /**
         * Maximum number of members that may belong to pool. If `None`, then the count of
         * members is not bound on a per pool basis.
         */
        MaxPoolMembersPerPool: StorageDescriptor<[], number, true, never>;
        /**
         * The maximum commission that can be charged by a pool. Used on commission payouts to bound
         * pool commissions that are > `GlobalMaxCommission`, necessary if a future
         * `GlobalMaxCommission` is lower than some current pool commissions.
         */
        GlobalMaxCommission: StorageDescriptor<[], number, true, never>;
        /**
         * Active members.
         *
         * TWOX-NOTE: SAFE since `AccountId` is a secure hash.
         */
        PoolMembers: StorageDescriptor<[Key: SS58String], Anonymize<Idphjddn2h69vc>, true, never>;
        /**
         * Counter for the related counted storage map
         */
        CounterForPoolMembers: StorageDescriptor<[], number, false, never>;
        /**
         * Storage for bonded pools.
         */
        BondedPools: StorageDescriptor<[Key: number], Anonymize<Ia8n1658h0bakq>, true, never>;
        /**
         * Counter for the related counted storage map
         */
        CounterForBondedPools: StorageDescriptor<[], number, false, never>;
        /**
         * Reward pools. This is where there rewards for each pool accumulate. When a members payout is
         * claimed, the balance comes out of the reward pool. Keyed by the bonded pools account.
         */
        RewardPools: StorageDescriptor<[Key: number], Anonymize<If6qa32dj75gu1>, true, never>;
        /**
         * Counter for the related counted storage map
         */
        CounterForRewardPools: StorageDescriptor<[], number, false, never>;
        /**
         * Groups of unbonding pools. Each group of unbonding pools belongs to a
         * bonded pool, hence the name sub-pools. Keyed by the bonded pools account.
         */
        SubPoolsStorage: StorageDescriptor<[Key: number], Anonymize<I7oo2mprv1qd1s>, true, never>;
        /**
         * Counter for the related counted storage map
         */
        CounterForSubPoolsStorage: StorageDescriptor<[], number, false, never>;
        /**
         * Metadata for the pool.
         */
        Metadata: StorageDescriptor<[Key: number], Binary, false, never>;
        /**
         * Counter for the related counted storage map
         */
        CounterForMetadata: StorageDescriptor<[], number, false, never>;
        /**
         * Ever increasing number of all pools created so far.
         */
        LastPoolId: StorageDescriptor<[], number, false, never>;
        /**
         * A reverse lookup from the pool's account id to its id.
         *
         * This is only used for slashing and on automatic withdraw update. In all other instances, the
         * pool id is used, and the accounts are deterministically derived from it.
         */
        ReversePoolIdLookup: StorageDescriptor<[Key: SS58String], number, true, never>;
        /**
         * Counter for the related counted storage map
         */
        CounterForReversePoolIdLookup: StorageDescriptor<[], number, false, never>;
        /**
         * Map from a pool member account to their opted claim permission.
         */
        ClaimPermissions: StorageDescriptor<[Key: SS58String], NominationPoolsClaimPermission, false, never>;
    };
    Scheduler: {
        /**
        
         */
        IncompleteSince: StorageDescriptor<[], bigint, true, never>;
        /**
         * Items to be executed, indexed by the block number that they should be executed on.
         */
        Agenda: StorageDescriptor<[Key: bigint], Anonymize<I8b18sngtfv9qe>, false, never>;
        /**
         * Retry configurations for items to be executed, indexed by task address.
         */
        Retries: StorageDescriptor<[Key: Anonymize<I6cs1itejju2vv>], Anonymize<I2n348ct50b2mp>, true, never>;
        /**
         * Lookup from a name to the block number and index of the task.
         *
         * For v3 -> v4 the previously unbounded identities are Blake2-256 hashed to form the v4
         * identities.
         */
        Lookup: StorageDescriptor<[Key: FixedSizeBinary<32>], Anonymize<I6cs1itejju2vv>, true, never>;
    };
    Preimage: {
        /**
         * The request status of a given hash.
         */
        StatusFor: StorageDescriptor<[Key: FixedSizeBinary<32>], PreimageOldRequestStatus, true, never>;
        /**
         * The request status of a given hash.
         */
        RequestStatusFor: StorageDescriptor<[Key: FixedSizeBinary<32>], Anonymize<I8j24837rs9r0t>, true, never>;
        /**
        
         */
        PreimageFor: StorageDescriptor<[Key: Anonymize<I4pact7n2e9a0i>], Binary, true, never>;
    };
    Offences: {
        /**
         * The primary structure that holds all offence records keyed by report identifiers.
         */
        Reports: StorageDescriptor<[Key: FixedSizeBinary<32>], Anonymize<I2bqvqrg0sbrdj>, true, never>;
        /**
         * A vector of reports of the same kind that happened at the same time slot.
         */
        ConcurrentReportsIndex: StorageDescriptor<Anonymize<I23nq3fsgtejt>, Anonymize<Ic5m5lp1oioo8r>, false, never>;
    };
    TxPause: {
        /**
         * The set of calls that are explicitly paused.
         */
        PausedCalls: StorageDescriptor<[Key: Anonymize<Idkbvh6dahk1v7>], null, true, never>;
    };
    ImOnline: {
        /**
         * The block number after which it's ok to send heartbeats in the current
         * session.
         *
         * At the beginning of each session we set this to a value that should fall
         * roughly in the middle of the session duration. The idea is to first wait for
         * the validators to produce a block in the current session, so that the
         * heartbeat later on will not be necessary.
         *
         * This value will only be used as a fallback if we fail to get a proper session
         * progress estimate from `NextSessionRotation`, as those estimates should be
         * more accurate then the value we calculate for `HeartbeatAfter`.
         */
        HeartbeatAfter: StorageDescriptor<[], bigint, false, never>;
        /**
         * The current set of keys that may issue a heartbeat.
         */
        Keys: StorageDescriptor<[], Anonymize<Ic5m5lp1oioo8r>, false, never>;
        /**
         * For each session index, we keep a mapping of `SessionIndex` and `AuthIndex`.
         */
        ReceivedHeartbeats: StorageDescriptor<Anonymize<I9jd27rnpm8ttv>, boolean, true, never>;
        /**
         * For each session index, we keep a mapping of `ValidatorId<T>` to the
         * number of blocks authored by the given authority.
         */
        AuthoredBlocks: StorageDescriptor<Anonymize<I7svnfko10tq2e>, number, false, never>;
    };
    Identity: {
        /**
         * Information that is pertinent to identify the entity behind an account. First item is the
         * registration, second is the account's primary username.
         *
         * TWOX-NOTE: OK ― `AccountId` is a secure hash.
         */
        IdentityOf: StorageDescriptor<[Key: SS58String], Anonymize<I1evsr8hplu1lg>, true, never>;
        /**
         * The super-identity of an alternative "sub" identity together with its name, within that
         * context. If the account is not some other account's sub-identity, then just `None`.
         */
        SuperOf: StorageDescriptor<[Key: SS58String], Anonymize<I910puuahutflf>, true, never>;
        /**
         * Alternative "sub" identities of this account.
         *
         * The first item is the deposit, the second is a vector of the accounts.
         *
         * TWOX-NOTE: OK ― `AccountId` is a secure hash.
         */
        SubsOf: StorageDescriptor<[Key: SS58String], Anonymize<I4nfjdef0ibh44>, false, never>;
        /**
         * The set of registrars. Not expected to get very big as can only be added through a
         * special origin (likely a council motion).
         *
         * The index into this can be cast to `RegistrarIndex` to get a valid value.
         */
        Registrars: StorageDescriptor<[], Anonymize<I74af64m08r6as>, false, never>;
        /**
         * A map of the accounts who are authorized to grant usernames.
         */
        UsernameAuthorities: StorageDescriptor<[Key: SS58String], Anonymize<I9bhbof2vim227>, true, never>;
        /**
         * Reverse lookup from `username` to the `AccountId` that has registered it. The value should
         * be a key in the `IdentityOf` map, but it may not if the user has cleared their identity.
         *
         * Multiple usernames may map to the same `AccountId`, but `IdentityOf` will only map to one
         * primary username.
         */
        AccountOfUsername: StorageDescriptor<[Key: Binary], SS58String, true, never>;
        /**
         * Usernames that an authority has granted, but that the account controller has not confirmed
         * that they want it. Used primarily in cases where the `AccountId` cannot provide a signature
         * because they are a pure proxy, multisig, etc. In order to confirm it, they should call
         * [`Call::accept_username`].
         *
         * First tuple item is the account and second is the acceptance deadline.
         */
        PendingUsernames: StorageDescriptor<[Key: Binary], Anonymize<I95l2k9b1re95f>, true, never>;
    };
    Multisig: {
        /**
         * The set of open multisig operations.
         */
        Multisigs: StorageDescriptor<Anonymize<I8uo3fpd3bcc6f>, Anonymize<Iahvoath23ldhv>, true, never>;
    };
    Ethereum: {
        /**
         * Current building block's transactions and receipts.
         */
        Pending: StorageDescriptor<[], Anonymize<Ic17drnrq0rtgi>, false, never>;
        /**
         * The current Ethereum block.
         */
        CurrentBlock: StorageDescriptor<[], Anonymize<Idi27giun0mb9q>, true, never>;
        /**
         * The current Ethereum receipts.
         */
        CurrentReceipts: StorageDescriptor<[], Anonymize<Idud3fdh64aqp9>, true, never>;
        /**
         * The current transaction statuses.
         */
        CurrentTransactionStatuses: StorageDescriptor<[], Anonymize<Ie7atdsih6q14b>, true, never>;
        /**
        
         */
        BlockHash: StorageDescriptor<[Key: Anonymize<I4totqt881mlti>], FixedSizeBinary<32>, false, never>;
    };
    EVM: {
        /**
        
         */
        AccountCodes: StorageDescriptor<[Key: FixedSizeBinary<20>], Binary, false, never>;
        /**
        
         */
        AccountCodesMetadata: StorageDescriptor<[Key: FixedSizeBinary<20>], Anonymize<I7jidl7qnnq87c>, true, never>;
        /**
        
         */
        AccountStorages: StorageDescriptor<Anonymize<I82cps8ng2jtug>, FixedSizeBinary<32>, false, never>;
        /**
        
         */
        Suicided: StorageDescriptor<[Key: FixedSizeBinary<20>], null, true, never>;
        /**
        
         */
        WhitelistedCreators: StorageDescriptor<[], Anonymize<I4gqmlq9k6jlk3>, false, never>;
    };
    EVMChainId: {
        /**
         * The EVM chain ID.
         */
        ChainId: StorageDescriptor<[], bigint, false, never>;
    };
    DynamicFee: {
        /**
        
         */
        MinGasPrice: StorageDescriptor<[], Anonymize<I4totqt881mlti>, false, never>;
        /**
        
         */
        TargetMinGasPrice: StorageDescriptor<[], Anonymize<I4totqt881mlti>, true, never>;
    };
    BaseFee: {
        /**
        
         */
        BaseFeePerGas: StorageDescriptor<[], Anonymize<I4totqt881mlti>, false, never>;
        /**
        
         */
        Elasticity: StorageDescriptor<[], number, false, never>;
    };
    Proxy: {
        /**
         * The set of account proxies. Maps the account which has delegated to the accounts
         * which are being delegated to, together with the amount held on deposit.
         */
        Proxies: StorageDescriptor<[Key: SS58String], Anonymize<I2gp57ssjscm57>, false, never>;
        /**
         * The announcements made by the proxy (key).
         */
        Announcements: StorageDescriptor<[Key: SS58String], Anonymize<I43vorjrsfs83q>, false, never>;
    };
    Registration: {
        /**
        
         */
        DisabledNodeTypes: StorageDescriptor<[Key: Anonymize<I9ea6lu6bbueo9>], boolean, false, never>;
        /**
        
         */
        ColdkeyNodeRegistration: StorageDescriptor<[Key: Binary], Anonymize<I1k1g0avb0ugrv>, false, never>;
        /**
         * Storage for banned account IDs
         */
        BannedAccounts: StorageDescriptor<[Key: SS58String], boolean, false, never>;
        /**
        
         */
        ValidatorWhitelistEnabled: StorageDescriptor<[], boolean, false, never>;
        /**
         * Tracks when nodes were deregistered
         */
        NodeLastDeregisteredAt: StorageDescriptor<[Key: Binary], bigint, false, never>;
        /**
         * Stores the linked node IDs for each main node
         */
        LinkedNodes: StorageDescriptor<[Key: Binary], Anonymize<Itom7fk49o0c9>, false, never>;
        /**
        
         */
        WhitelistedValidators: StorageDescriptor<[], Anonymize<Ia2lhg7l2hilo3>, false, never>;
        /**
        
         */
        NodeRegistration: StorageDescriptor<[Key: Binary], Anonymize<I1k1g0avb0ugrv>, false, never>;
        /**
        
         */
        ReportSubmissionCount: StorageDescriptor<[Key: Binary], number, false, never>;
        /**
        
         */
        TemporaryDeregistrationReports: StorageDescriptor<[Key: SS58String], Anonymize<I794shhubguhfe>, false, never>;
        /**
        
         */
        FeeChargingEnabled: StorageDescriptor<[], boolean, false, never>;
        /**
        
         */
        CurrentNodeTypeFee: StorageDescriptor<[Key: Anonymize<I9ea6lu6bbueo9>], bigint, false, never>;
        /**
        
         */
        LastRegistrationBlock: StorageDescriptor<[Key: Anonymize<I9ea6lu6bbueo9>], bigint, false, never>;
        /**
         * One-shot challenge guard (replay protection)
         */
        UsedChallenges: StorageDescriptor<[Key: FixedSizeBinary<32>], bigint, false, never>;
        /**
         * Remember the bound libp2p identities (by your node_id)
         */
        Libp2pMainIdentity: StorageDescriptor<[Key: Binary], Anonymize<Ic2gqqe3boa6j>, true, never>;
        /**
        
         */
        Libp2pIpfsIdentity: StorageDescriptor<[Key: Binary], Anonymize<Ic2gqqe3boa6j>, true, never>;
        /**
        
         */
        DeregistrationEnabled: StorageDescriptor<[], boolean, false, never>;
    };
    ExecutionUnit: {
        /**
         * A vector storing block numbers for each block processed.
         */
        BlockNumbers: StorageDescriptor<[Key: Binary], Anonymize<Iafqnechp3omqg>, true, never>;
        /**
        
         */
        NodeMetrics: StorageDescriptor<[Key: Binary], Anonymize<Irepiuosq268n>, true, never>;
        /**
        
         */
        PurgeDeregisteredNodesEnabled: StorageDescriptor<[], boolean, false, never>;
        /**
        
         */
        TemporaryPinReports: StorageDescriptor<Anonymize<I4p8l84tk038s>, Anonymize<I69kk348jhe683>, true, never>;
        /**
        
         */
        RequestsCount: StorageDescriptor<[Key: Binary], number, false, never>;
        /**
        
         */
        HardwareRequestsCount: StorageDescriptor<[Key: Binary], number, false, never>;
        /**
        
         */
        TotalPinChecksPerEpoch: StorageDescriptor<[Key: Binary], number, false, never>;
        /**
        
         */
        SuccessfulPinChecksPerEpoch: StorageDescriptor<[Key: Binary], number, false, never>;
        /**
        
         */
        TotalPingChecksPerEpoch: StorageDescriptor<[Key: Binary], number, false, never>;
        /**
        
         */
        SuccessfulPingChecksPerEpoch: StorageDescriptor<[Key: Binary], number, false, never>;
        /**
        
         */
        HardwareRequestsLastBlock: StorageDescriptor<[Key: Binary], bigint, false, never>;
    };
    Metagraph: {
        /**
        
         */
        UIDs: StorageDescriptor<[], Anonymize<Ifl5oat0rhcq32>, false, never>;
        /**
        
         */
        ValidatorSubmissions: StorageDescriptor<[Key: bigint], Anonymize<I5ofvu2mgb3ik6>, false, never>;
        /**
        
         */
        WhitelistedValidators: StorageDescriptor<[], Anonymize<Ia2lhg7l2hilo3>, false, never>;
        /**
        
         */
        ValidatorTrustPoints: StorageDescriptor<[Key: SS58String], number, false, never>;
        /**
        
         */
        StoredDividends: StorageDescriptor<[], Anonymize<Icgljjb6j82uhn>, false, never>;
    };
    Marketplace: {
        /**
        
         */
        Plans: StorageDescriptor<[Key: FixedSizeBinary<32>], Anonymize<If8b3rdbls82p1>, true, never>;
        /**
        
         */
        PricePerGbs: StorageDescriptor<[], bigint, false, never>;
        /**
        
         */
        PricePerBandwidth: StorageDescriptor<[], bigint, false, never>;
        /**
         * Storage to track the last charged timestamp for each user
         */
        StorageLastChargedAt: StorageDescriptor<[Key: SS58String], bigint, false, never>;
        /**
        
         */
        UserPlanSubscriptions: StorageDescriptor<[Key: SS58String], Anonymize<I3f35fplll6ic0>, true, never>;
        /**
        
         */
        UserAllSubscriptionPlans: StorageDescriptor<[Key: SS58String], Anonymize<I2ek94e7loqjdr>, false, never>;
        /**
        
         */
        OSDiskImageUrls: StorageDescriptor<[Key: Binary], Anonymize<I2plnma28qqa7d>, true, never>;
        /**
        
         */
        Batches: StorageDescriptor<[Key: bigint], Anonymize<I30u3t989dudrc>, true, never>;
        /**
        
         */
        UserBatches: StorageDescriptor<[Key: SS58String], Anonymize<Iafqnechp3omqg>, true, never>;
        /**
        
         */
        IsStorageOperationsEnabled: StorageDescriptor<[], boolean, false, never>;
        /**
        
         */
        IsPurchasePlanEnabled: StorageDescriptor<[], boolean, false, never>;
        /**
        
         */
        NextBatchId: StorageDescriptor<[], bigint, false, never>;
        /**
        
         */
        CdnLocations: StorageDescriptor<[Key: number], Anonymize<I41jij06egn8q0>, true, never>;
        /**
        
         */
        NextSubscriptionId: StorageDescriptor<[], number, false, never>;
        /**
        
         */
        PointTransactions: StorageDescriptor<Anonymize<I6ouflveob4eli>, Anonymize<I8052e8591l2k5>, true, never>;
        /**
        
         */
        NextTransactionId: StorageDescriptor<[Key: SS58String], number, false, never>;
        /**
        
         */
        BackupEnabledUsers: StorageDescriptor<[], Anonymize<Ia2lhg7l2hilo3>, false, never>;
        /**
        
         */
        BackupDeleteRequests: StorageDescriptor<[], Anonymize<Ia2lhg7l2hilo3>, false, never>;
        /**
        
         */
        SpecificMinerRequestFee: StorageDescriptor<[], bigint, false, never>;
        /**
        
         */
        UserRequestsCount: StorageDescriptor<[Key: SS58String], number, false, never>;
        /**
        
         */
        SudoKey: StorageDescriptor<[], Anonymize<Ihfphjolmsqq1>, false, never>;
    };
    SubAccount: {
        /**
         * Store the main account of a given address
         */
        SubAccount: StorageDescriptor<[Key: SS58String], SS58String, true, never>;
        /**
         * New storage for sub-account roles (added without modifying existing storage)
         */
        SubAccountRole: StorageDescriptor<[Key: SS58String], Anonymize<I15h251r958qnn>, true, never>;
    };
    Notifications: {
        /**
         * Storage for notifications
         */
        Notifications: StorageDescriptor<[Key: SS58String], Anonymize<I5ocim6bqhcb87>, false, never>;
        /**
        
         */
        BannedAccounts: StorageDescriptor<[Key: SS58String], null, true, never>;
        /**
        
         */
        LastCallTime: StorageDescriptor<[Key: SS58String], bigint, true, never>;
    };
    AccountProfile: {
        /**
         * Storage for public data
         */
        UserPublicStorage: StorageDescriptor<[Key: SS58String], Binary, false, never>;
        /**
         * Storage for Data Public Keys
         * Maps an AccountId to their Data Public Key
         */
        DataPublicKeys: StorageDescriptor<[Key: SS58String], Binary, true, never>;
        /**
         * Storage for Message Public Keys
         * Maps an AccountId to their Message Public Key
         */
        MessagePublicKeys: StorageDescriptor<[Key: SS58String], Binary, true, never>;
        /**
         * Storage for private data
         */
        UserPrivateStorage: StorageDescriptor<[Key: SS58String], Binary, false, never>;
        /**
         * Storage for usernames
         * Maps a username to an account ID, ensuring usernames are unique.
         */
        Usernames: StorageDescriptor<[Key: Binary], SS58String, true, never>;
        /**
         * Storage to map an account ID to their username.
         */
        AccountUsernames: StorageDescriptor<[Key: SS58String], Binary, true, never>;
    };
    Utils: {
        /**
        
         */
        MetagraphSubmissionEnabled: StorageDescriptor<[], boolean, false, never>;
        /**
        
         */
        WeightSubmissionEnabled: StorageDescriptor<[], boolean, false, never>;
    };
    RankingStorage: {
        /**
        
         */
        RankDistributionLimit: StorageDescriptor<[], number, false, never>;
        /**
        
         */
        RankedList: StorageDescriptor<[], Anonymize<I9fmfdj27dod2r>, false, never>;
        /**
        
         */
        LastGlobalUpdate: StorageDescriptor<[], bigint, false, never>;
        /**
        
         */
        RewardsRecord: StorageDescriptor<[Key: Binary], Anonymize<Ie9ca3ooag8pvg>, false, never>;
    };
    RankingCompute: {
        /**
        
         */
        RankDistributionLimit: StorageDescriptor<[], number, false, never>;
        /**
        
         */
        RankedList: StorageDescriptor<[], Anonymize<I9fmfdj27dod2r>, false, never>;
        /**
        
         */
        LastGlobalUpdate: StorageDescriptor<[], bigint, false, never>;
        /**
        
         */
        RewardsRecord: StorageDescriptor<[Key: Binary], Anonymize<Ie9ca3ooag8pvg>, false, never>;
    };
    RankingValidators: {
        /**
        
         */
        RankDistributionLimit: StorageDescriptor<[], number, false, never>;
        /**
        
         */
        RankedList: StorageDescriptor<[], Anonymize<I9fmfdj27dod2r>, false, never>;
        /**
        
         */
        LastGlobalUpdate: StorageDescriptor<[], bigint, false, never>;
        /**
        
         */
        RewardsRecord: StorageDescriptor<[Key: Binary], Anonymize<Ie9ca3ooag8pvg>, false, never>;
    };
    Credits: {
        /**
        
         */
        Authorities: StorageDescriptor<[], Anonymize<Ia2lhg7l2hilo3>, false, never>;
        /**
        
         */
        ReferralCodeRewards: StorageDescriptor<[Key: Binary], bigint, false, never>;
        /**
        
         */
        ReferralCodeUsageCount: StorageDescriptor<[Key: Binary], number, false, never>;
        /**
        
         */
        TotalReferralCodes: StorageDescriptor<[], number, false, never>;
        /**
        
         */
        TotalSucessfullCreditsTransfers: StorageDescriptor<[], bigint, false, never>;
        /**
        
         */
        LastReferralCreationBlock: StorageDescriptor<[Key: SS58String], bigint, true, never>;
        /**
        
         */
        TotalReferralRewards: StorageDescriptor<[], bigint, false, never>;
        /**
        
         */
        ReferralCodes: StorageDescriptor<[Key: Binary], SS58String, true, never>;
        /**
        
         */
        ReferredUsers: StorageDescriptor<[Key: SS58String], Binary, true, never>;
        /**
        
         */
        TotalCreditsPurchased: StorageDescriptor<[], bigint, false, never>;
        /**
        
         */
        AlphaBalances: StorageDescriptor<[Key: SS58String], bigint, false, never>;
        /**
        
         */
        FreeCredits: StorageDescriptor<[Key: SS58String], bigint, false, never>;
        /**
        
         */
        CurrentLockPeriod: StorageDescriptor<[], Anonymize<I2dlsvlc18d84>, true, never>;
        /**
        
         */
        AlphaPrice: StorageDescriptor<[], bigint, false, never>;
        /**
        
         */
        MinLockAmount: StorageDescriptor<[], bigint, true, never>;
        /**
        
         */
        LockedCredits: StorageDescriptor<[Key: SS58String], Anonymize<Ifv97gfrl1guc>, false, never>;
    };
    ContainerRegistry: {
        /**
        
         */
        NextSpaceId: StorageDescriptor<[], bigint, false, never>;
        /**
         * Storage for Spaces
         */
        Spaces: StorageDescriptor<[Key: bigint], Anonymize<If55bm6vm10gt4>, true, never>;
        /**
        
         */
        ManifestDigests: StorageDescriptor<[Key: Anonymize<I57odkpjf7icor>], Binary, true, never>;
        /**
         * Digest to Info Storage Map
         * Maps digest to its type and CID
         * this is for storing blobs
         */
        DigestInfoStorage: StorageDescriptor<[Key: Binary], Anonymize<I3ks7h4esgu87b>, true, never>;
        /**
         * Image Name + Digest to CID Storage Map
         * Maps (image_name, digest) to cid
         * this is for storing manifest json
         */
        ImageDigestToCid: StorageDescriptor<Anonymize<Idkbvh6dahk1v7>, Binary, true, never>;
    };
    AlphaBridge: {
        /**
         * Guardian accounts authorized to attest deposits and withdrawals
         */
        Guardians: StorageDescriptor<[], Anonymize<Ia2lhg7l2hilo3>, false, never>;
        /**
         * Minimum guardian approvals needed to complete an action
         */
        ApproveThreshold: StorageDescriptor<[], number, false, never>;
        /**
         * Maximum allowed minted hAlpha (set via governance/sudo)
         */
        GlobalMintCap: StorageDescriptor<[], bigint, false, never>;
        /**
         * Running total of all minted hAlpha (used for mint cap enforcement)
         */
        TotalMintedByBridge: StorageDescriptor<[], bigint, false, never>;
        /**
         * Emergency pause switch (blocks all bridge operations when true)
         */
        Paused: StorageDescriptor<[], boolean, false, never>;
        /**
         * Deposits created by guardians when they observe deposit_requests on Bittensor
         * Key: DepositId (same as Bittensor deposit_request ID)
         */
        Deposits: StorageDescriptor<[Key: FixedSizeBinary<32>], Anonymize<I5tr5ve03qkqub>, true, never>;
        /**
         * Withdrawal requests created by users (hAlpha burned immediately)
         * Key: WithdrawalRequestId
         */
        WithdrawalRequests: StorageDescriptor<[Key: FixedSizeBinary<32>], Anonymize<Ibshtksbg4cn8s>, true, never>;
        /**
         * Nonce for generating unique withdrawal request IDs
         */
        NextWithdrawalRequestNonce: StorageDescriptor<[], bigint, false, never>;
        /**
         * TTL in blocks before finalized records can be cleaned up
         * Default: 100800 blocks (~7 days at 6s blocks)
         */
        CleanupTTLBlocks: StorageDescriptor<[], bigint, false, never>;
        /**
         * Minimum withdrawal amount (in halphaRao)
         */
        MinWithdrawalAmount: StorageDescriptor<[], bigint, false, never>;
    };
    PalletIp: {
        /**
         * Separate IP pools for each role type
         */
        AvailableHypervisorIps: StorageDescriptor<[], Anonymize<Itom7fk49o0c9>, false, never>;
        /**
        
         */
        AvailableClientIps: StorageDescriptor<[], Anonymize<Itom7fk49o0c9>, false, never>;
        /**
        
         */
        AvailableStorageMinerIps: StorageDescriptor<[], Anonymize<Itom7fk49o0c9>, false, never>;
        /**
         * Pool of available IP addresses
         */
        VmAvailableIps: StorageDescriptor<[], Anonymize<Itom7fk49o0c9>, false, never>;
        /**
        
         */
        AssignedVmIps: StorageDescriptor<[], Anonymize<Itom7fk49o0c9>, false, never>;
        /**
        
         */
        AssignedClientIps: StorageDescriptor<[], Anonymize<Itom7fk49o0c9>, false, never>;
        /**
        
         */
        IpToRole: StorageDescriptor<[Key: Binary], Anonymize<Ia79cnsrsjj9f>, true, never>;
        /**
        
         */
        RoleToIp: StorageDescriptor<[Key: Anonymize<Ia79cnsrsjj9f>], Binary, true, never>;
        /**
        
         */
        IpReleaseRequests: StorageDescriptor<[], Anonymize<I826pe08hg303r>, false, never>;
    };
    IpfsPallet: {
        /**
        
         */
        RequestsCount: StorageDescriptor<[Key: Binary], number, false, never>;
        /**
        
         */
        CurrentEpochValidator: StorageDescriptor<[], Anonymize<I92hdo1clkbp4g>, false, never>;
        /**
        
         */
        UserTotalFilesSize: StorageDescriptor<[Key: SS58String], bigint, true, never>;
        /**
        
         */
        MinerTotalFilesSize: StorageDescriptor<[Key: Binary], bigint, true, never>;
        /**
        
         */
        MinerTotalFilesPinned: StorageDescriptor<[Key: Binary], number, true, never>;
        /**
        
         */
        UserStorageRequests: StorageDescriptor<Anonymize<I92tce08cbhnmn>, Anonymize<I2r873a4ldk78h>, false, never>;
        /**
        
         */
        BlacklistedUsers: StorageDescriptor<[Key: SS58String], boolean, false, never>;
        /**
        
         */
        UserUnpinRequests: StorageDescriptor<[], Anonymize<I1liagipf62t7o>, false, never>;
        /**
        
         */
        ReputationPoints: StorageDescriptor<[Key: SS58String], number, false, never>;
        /**
        
         */
        RebalanceRequest: StorageDescriptor<[], Anonymize<I9ul39lmd4kq7>, false, never>;
        /**
        
         */
        Blacklist: StorageDescriptor<[], Anonymize<Itom7fk49o0c9>, false, never>;
        /**
        
         */
        UnpinRequests: StorageDescriptor<[], Anonymize<Itom7fk49o0c9>, false, never>;
        /**
        
         */
        RotationWhitelistingEnabled: StorageDescriptor<[], boolean, false, never>;
        /**
        
         */
        MinerProfile: StorageDescriptor<[Key: Binary], Binary, false, never>;
        /**
        
         */
        UserProfile: StorageDescriptor<[Key: SS58String], Binary, false, never>;
        /**
        
         */
        PinningEnabled: StorageDescriptor<[], boolean, false, never>;
        /**
        
         */
        AssignmentEnabled: StorageDescriptor<[], boolean, false, never>;
    };
    Arion: {
        /**
         * Current CRUSH epoch.
         */
        CurrentEpoch: StorageDescriptor<[], bigint, false, never>;
        /**
         * CRUSH params per epoch.
         */
        EpochParams: StorageDescriptor<[Key: bigint], Anonymize<I2igc2btujm50s>, true, never>;
        /**
         * Miners for a given epoch (bounded).
         */
        EpochMiners: StorageDescriptor<[Key: bigint], Anonymize<Ianojun924rii6>, true, never>;
        /**
         * Root hash (commitment) of the canonical epoch map encoding (miners sorted by uid).
         */
        EpochRoot: StorageDescriptor<[Key: bigint], FixedSizeBinary<32>, true, never>;
        /**
         * Latest stats bucket id (e.g. block_number / N).
         */
        CurrentStatsBucket: StorageDescriptor<[], number, false, never>;
        /**
         * Latest network totals for `CurrentStatsBucket`.
         */
        CurrentNetworkTotals: StorageDescriptor<[], Anonymize<Ibp595vp69nb95>, false, never>;
        /**
         * Stats by miner uid (latest).
         */
        MinerStatsByUid: StorageDescriptor<[Key: number], Anonymize<Iegso6e591humo>, true, never>;
        /**
         * Current attestation bucket (monotonic).
         */
        CurrentAttestationBucket: StorageDescriptor<[], number, false, never>;
        /**
         * Attestations by bucket (bounded list of attestation records).
         */
        AttestationsByBucket: StorageDescriptor<[Key: number], Anonymize<I21oce8fars5kb>, false, never>;
        /**
         * Epoch attestation commitments for third-party verification.
         *
         * Maps epoch → commitment containing merkle roots and Arion content hash.
         * The full attestation bundle can be retrieved from Arion using the content hash.
         */
        EpochAttestationCommitments: StorageDescriptor<[Key: bigint], Anonymize<I2nnfiu9n558kd>, true, never>;
        /**
         * Registered wardens authorized to submit attestations.
         *
         * Maps warden Ed25519 public key (32 bytes) → registration info.
         * This enables third-party verification of warden authorization.
         */
        RegisteredWardens: StorageDescriptor<[Key: FixedSizeBinary<32>], Anonymize<I84g50k59vdko9>, true, never>;
        /**
         * Total count of active (not deregistered) wardens.
         */
        ActiveWardenCount: StorageDescriptor<[], number, false, never>;
        /**
         * Whether registration lockup (reserve/unbond) is enabled.
         *
         * If disabled:
         * - `register_child` does not reserve deposits (deposit = 0)
         * - global fee curve does not advance
         * - `deregister_child` unbonding becomes immediate (still enforces cooldown)
         */
        LockupEnabled: StorageDescriptor<[], boolean, false, never>;
        /**
         * Runtime-configurable base deposit (floor for the global fee curve).
         */
        BaseChildDepositValue: StorageDescriptor<[], bigint, false, never>;
        /**
         * Number of families that have claimed the “first child free” slot.
         */
        FamilyCount: StorageDescriptor<[], number, false, never>;
        /**
         * Whether a family has already used its one-time free registration.
         */
        FamilyUsedFreeSlot: StorageDescriptor<[Key: SS58String], boolean, false, never>;
        /**
         * Active children count per family.
         */
        FamilyActiveChildren: StorageDescriptor<[Key: SS58String], number, false, never>;
        /**
         * Total active children across all families.
         */
        TotalActiveChildren: StorageDescriptor<[], number, false, never>;
        /**
         * Global next required deposit for paid child registration (network-wide adaptive fee).
         */
        GlobalNextDeposit: StorageDescriptor<[], bigint, false, never>;
        /**
         * Last block when a paid child registration happened (for lazy halving).
         */
        GlobalLastPaidRegistrationBlock: StorageDescriptor<[], bigint, false, never>;
        /**
         * Child registration record (only while Active/Unbonding).
         */
        ChildRegistrations: StorageDescriptor<[Key: SS58String], Anonymize<I92o2mr60mvqni>, true, never>;
        /**
         * Node id -> current child (active only).
         */
        NodeIdToChild: StorageDescriptor<[Key: FixedSizeBinary<32>], SS58String, true, never>;
        /**
         * Prevent replay across (de)registration cycles: nonce per node id.
         */
        NodeIdNonce: StorageDescriptor<[Key: FixedSizeBinary<32>], bigint, false, never>;
        /**
         * Cooldown until (block number) for child accounts (after deregistration).
         */
        ChildCooldownUntil: StorageDescriptor<[Key: SS58String], bigint, false, never>;
        /**
         * Cooldown until for node ids (after deregistration).
         */
        NodeIdCooldownUntil: StorageDescriptor<[Key: FixedSizeBinary<32>], bigint, false, never>;
        /**
         * Active children list per family (needed to aggregate per-family weights safely).
         */
        FamilyChildren: StorageDescriptor<[Key: SS58String], Anonymize<Ia2lhg7l2hilo3>, false, never>;
        /**
         * Current weight bucket (monotonic).
         */
        CurrentWeightBucket: StorageDescriptor<[], number, false, never>;
        /**
         * Latest per-node (child) weight.
         */
        NodeWeightByChild: StorageDescriptor<[Key: SS58String], number, false, never>;
        /**
         * Last bucket when a node (child) weight was updated.
         */
        NodeWeightLastBucket: StorageDescriptor<[Key: SS58String], number, false, never>;
        /**
         * Latest validator-reported quality inputs per node (child).
         */
        NodeQualityByChild: StorageDescriptor<[Key: SS58String], Anonymize<I86kjcprqpmpbf>, true, never>;
        /**
         * Latest raw (unsmoothed) family weight (derived from node weights).
         */
        FamilyWeightRaw: StorageDescriptor<[Key: SS58String], number, false, never>;
        /**
         * Latest smoothed family weight (EMA + delta clamp).
         */
        FamilyWeight: StorageDescriptor<[Key: SS58String], number, false, never>;
        /**
         * First bucket a family became active (for newcomer grace).
         */
        FamilyFirstSeenBucket: StorageDescriptor<[Key: SS58String], number, true, never>;
    };
};
type ICalls = {
    System: {
        /**
         * Make some on-chain remark.
         *
         * Can be executed by every `origin`.
         */
        remark: TxDescriptor<Anonymize<I8ofcg5rbj0g2c>>;
        /**
         * Set the number of pages in the WebAssembly environment's heap.
         */
        set_heap_pages: TxDescriptor<Anonymize<I4adgbll7gku4i>>;
        /**
         * Set the new runtime code.
         */
        set_code: TxDescriptor<Anonymize<I6pjjpfvhvcfru>>;
        /**
         * Set the new runtime code without doing any checks of the given `code`.
         *
         * Note that runtime upgrades will not run if this is called with a not-increasing spec
         * version!
         */
        set_code_without_checks: TxDescriptor<Anonymize<I6pjjpfvhvcfru>>;
        /**
         * Set some items of storage.
         */
        set_storage: TxDescriptor<Anonymize<I9pj91mj79qekl>>;
        /**
         * Kill some items from storage.
         */
        kill_storage: TxDescriptor<Anonymize<I39uah9nss64h9>>;
        /**
         * Kill all storage items with a key that starts with the given prefix.
         *
         * **NOTE:** We rely on the Root origin to provide us the number of subkeys under
         * the prefix we are removing to accurately calculate the weight of this function.
         */
        kill_prefix: TxDescriptor<Anonymize<Ik64dknsq7k08>>;
        /**
         * Make some on-chain remark and emit event.
         */
        remark_with_event: TxDescriptor<Anonymize<I8ofcg5rbj0g2c>>;
        /**
         * Authorize an upgrade to a given `code_hash` for the runtime. The runtime can be supplied
         * later.
         *
         * This call requires Root origin.
         */
        authorize_upgrade: TxDescriptor<Anonymize<Ib51vk42m1po4n>>;
        /**
         * Authorize an upgrade to a given `code_hash` for the runtime. The runtime can be supplied
         * later.
         *
         * WARNING: This authorizes an upgrade that will take place without any safety checks, for
         * example that the spec name remains the same and that the version number increases. Not
         * recommended for normal use. Use `authorize_upgrade` instead.
         *
         * This call requires Root origin.
         */
        authorize_upgrade_without_checks: TxDescriptor<Anonymize<Ib51vk42m1po4n>>;
        /**
         * Provide the preimage (runtime binary) `code` for an upgrade that has been authorized.
         *
         * If the authorization required a version check, this call will ensure the spec name
         * remains unchanged and that the spec version has increased.
         *
         * Depending on the runtime's `OnSetCode` configuration, this function may directly apply
         * the new `code` in the same block or attempt to schedule the upgrade.
         *
         * All origins are allowed.
         */
        apply_authorized_upgrade: TxDescriptor<Anonymize<I6pjjpfvhvcfru>>;
    };
    Timestamp: {
        /**
         * Set the current time.
         *
         * This call should be invoked exactly once per block. It will panic at the finalization
         * phase, if this call hasn't been invoked by that time.
         *
         * The timestamp should be greater than the previous one by the amount specified by
         * [`Config::MinimumPeriod`].
         *
         * The dispatch origin for this call must be _None_.
         *
         * This dispatch class is _Mandatory_ to ensure it gets executed in the block. Be aware
         * that changing the complexity of this call could result exhausting the resources in a
         * block to execute any other calls.
         *
         * ## Complexity
         * - `O(1)` (Note that implementations of `OnTimestampSet` must also be `O(1)`)
         * - 1 storage read and 1 storage mutation (codec `O(1)` because of `DidUpdate::take` in
         * `on_finalize`)
         * - 1 event handler `on_timestamp_set`. Must be `O(1)`.
         */
        set: TxDescriptor<Anonymize<Idcr6u6361oad9>>;
    };
    Sudo: {
        /**
         * Authenticates the sudo key and dispatches a function call with `Root` origin.
         */
        sudo: TxDescriptor<Anonymize<Ico5mjpqfgtpuj>>;
        /**
         * Authenticates the sudo key and dispatches a function call with `Root` origin.
         * This function does not check the weight of the call, and instead allows the
         * Sudo user to specify the weight of the call.
         *
         * The dispatch origin for this call must be _Signed_.
         */
        sudo_unchecked_weight: TxDescriptor<Anonymize<I46s97719jsq03>>;
        /**
         * Authenticates the current sudo key and sets the given AccountId (`new`) as the new sudo
         * key.
         */
        set_key: TxDescriptor<Anonymize<I79cmnv5q6b3p>>;
        /**
         * Authenticates the sudo key and dispatches a function call with `Signed` origin from
         * a given account.
         *
         * The dispatch origin for this call must be _Signed_.
         */
        sudo_as: TxDescriptor<Anonymize<If1fboivengemn>>;
        /**
         * Permanently removes the sudo key.
         *
         * **This cannot be un-done.**
         */
        remove_key: TxDescriptor<undefined>;
    };
    Assets: {
        /**
         * Issue a new class of fungible assets from a public origin.
         *
         * This new asset class has no assets initially and its owner is the origin.
         *
         * The origin must conform to the configured `CreateOrigin` and have sufficient funds free.
         *
         * Funds of sender are reserved by `AssetDeposit`.
         *
         * Parameters:
         * - `id`: The identifier of the new asset. This must not be currently in use to identify
         * an existing asset. If [`NextAssetId`] is set, then this must be equal to it.
         * - `admin`: The admin of this class of assets. The admin is the initial address of each
         * member of the asset class's admin team.
         * - `min_balance`: The minimum balance of this new asset that any single account must
         * have. If an account's balance is reduced below this, then it collapses to zero.
         *
         * Emits `Created` event when successful.
         *
         * Weight: `O(1)`
         */
        create: TxDescriptor<Anonymize<Ibh0d53vr9icth>>;
        /**
         * Issue a new class of fungible assets from a privileged origin.
         *
         * This new asset class has no assets initially.
         *
         * The origin must conform to `ForceOrigin`.
         *
         * Unlike `create`, no funds are reserved.
         *
         * - `id`: The identifier of the new asset. This must not be currently in use to identify
         * an existing asset. If [`NextAssetId`] is set, then this must be equal to it.
         * - `owner`: The owner of this class of assets. The owner has full superuser permissions
         * over this asset, but may later change and configure the permissions using
         * `transfer_ownership` and `set_team`.
         * - `min_balance`: The minimum balance of this new asset that any single account must
         * have. If an account's balance is reduced below this, then it collapses to zero.
         *
         * Emits `ForceCreated` event when successful.
         *
         * Weight: `O(1)`
         */
        force_create: TxDescriptor<Anonymize<I2sr30isvv1i3a>>;
        /**
         * Start the process of destroying a fungible asset class.
         *
         * `start_destroy` is the first in a series of extrinsics that should be called, to allow
         * destruction of an asset class.
         *
         * The origin must conform to `ForceOrigin` or must be `Signed` by the asset's `owner`.
         *
         * - `id`: The identifier of the asset to be destroyed. This must identify an existing
         * asset.
         *
         * The asset class must be frozen before calling `start_destroy`.
         */
        start_destroy: TxDescriptor<Anonymize<I4ov6e94l79mbg>>;
        /**
         * Destroy all accounts associated with a given asset.
         *
         * `destroy_accounts` should only be called after `start_destroy` has been called, and the
         * asset is in a `Destroying` state.
         *
         * Due to weight restrictions, this function may need to be called multiple times to fully
         * destroy all accounts. It will destroy `RemoveItemsLimit` accounts at a time.
         *
         * - `id`: The identifier of the asset to be destroyed. This must identify an existing
         * asset.
         *
         * Each call emits the `Event::DestroyedAccounts` event.
         */
        destroy_accounts: TxDescriptor<Anonymize<I4ov6e94l79mbg>>;
        /**
         * Destroy all approvals associated with a given asset up to the max (T::RemoveItemsLimit).
         *
         * `destroy_approvals` should only be called after `start_destroy` has been called, and the
         * asset is in a `Destroying` state.
         *
         * Due to weight restrictions, this function may need to be called multiple times to fully
         * destroy all approvals. It will destroy `RemoveItemsLimit` approvals at a time.
         *
         * - `id`: The identifier of the asset to be destroyed. This must identify an existing
         * asset.
         *
         * Each call emits the `Event::DestroyedApprovals` event.
         */
        destroy_approvals: TxDescriptor<Anonymize<I4ov6e94l79mbg>>;
        /**
         * Complete destroying asset and unreserve currency.
         *
         * `finish_destroy` should only be called after `start_destroy` has been called, and the
         * asset is in a `Destroying` state. All accounts or approvals should be destroyed before
         * hand.
         *
         * - `id`: The identifier of the asset to be destroyed. This must identify an existing
         * asset.
         *
         * Each successful call emits the `Event::Destroyed` event.
         */
        finish_destroy: TxDescriptor<Anonymize<I4ov6e94l79mbg>>;
        /**
         * Mint assets of a particular class.
         *
         * The origin must be Signed and the sender must be the Issuer of the asset `id`.
         *
         * - `id`: The identifier of the asset to have some amount minted.
         * - `beneficiary`: The account to be credited with the minted assets.
         * - `amount`: The amount of the asset to be minted.
         *
         * Emits `Issued` event when successful.
         *
         * Weight: `O(1)`
         * Modes: Pre-existing balance of `beneficiary`; Account pre-existence of `beneficiary`.
         */
        mint: TxDescriptor<Anonymize<I4mq3ssndm1dbu>>;
        /**
         * Reduce the balance of `who` by as much as possible up to `amount` assets of `id`.
         *
         * Origin must be Signed and the sender should be the Manager of the asset `id`.
         *
         * Bails with `NoAccount` if the `who` is already dead.
         *
         * - `id`: The identifier of the asset to have some amount burned.
         * - `who`: The account to be debited from.
         * - `amount`: The maximum amount by which `who`'s balance should be reduced.
         *
         * Emits `Burned` with the actual amount burned. If this takes the balance to below the
         * minimum for the asset, then the amount burned is increased to take it to zero.
         *
         * Weight: `O(1)`
         * Modes: Post-existence of `who`; Pre & post Zombie-status of `who`.
         */
        burn: TxDescriptor<Anonymize<I45oruu1f0aihd>>;
        /**
         * Move some assets from the sender account to another.
         *
         * Origin must be Signed.
         *
         * - `id`: The identifier of the asset to have some amount transferred.
         * - `target`: The account to be credited.
         * - `amount`: The amount by which the sender's balance of assets should be reduced and
         * `target`'s balance increased. The amount actually transferred may be slightly greater in
         * the case that the transfer would otherwise take the sender balance above zero but below
         * the minimum balance. Must be greater than zero.
         *
         * Emits `Transferred` with the actual amount transferred. If this takes the source balance
         * to below the minimum for the asset, then the amount transferred is increased to take it
         * to zero.
         *
         * Weight: `O(1)`
         * Modes: Pre-existence of `target`; Post-existence of sender; Account pre-existence of
         * `target`.
         */
        transfer: TxDescriptor<Anonymize<I80oivsrvtnpf1>>;
        /**
         * Move some assets from the sender account to another, keeping the sender account alive.
         *
         * Origin must be Signed.
         *
         * - `id`: The identifier of the asset to have some amount transferred.
         * - `target`: The account to be credited.
         * - `amount`: The amount by which the sender's balance of assets should be reduced and
         * `target`'s balance increased. The amount actually transferred may be slightly greater in
         * the case that the transfer would otherwise take the sender balance above zero but below
         * the minimum balance. Must be greater than zero.
         *
         * Emits `Transferred` with the actual amount transferred. If this takes the source balance
         * to below the minimum for the asset, then the amount transferred is increased to take it
         * to zero.
         *
         * Weight: `O(1)`
         * Modes: Pre-existence of `target`; Post-existence of sender; Account pre-existence of
         * `target`.
         */
        transfer_keep_alive: TxDescriptor<Anonymize<I80oivsrvtnpf1>>;
        /**
         * Move some assets from one account to another.
         *
         * Origin must be Signed and the sender should be the Admin of the asset `id`.
         *
         * - `id`: The identifier of the asset to have some amount transferred.
         * - `source`: The account to be debited.
         * - `dest`: The account to be credited.
         * - `amount`: The amount by which the `source`'s balance of assets should be reduced and
         * `dest`'s balance increased. The amount actually transferred may be slightly greater in
         * the case that the transfer would otherwise take the `source` balance above zero but
         * below the minimum balance. Must be greater than zero.
         *
         * Emits `Transferred` with the actual amount transferred. If this takes the source balance
         * to below the minimum for the asset, then the amount transferred is increased to take it
         * to zero.
         *
         * Weight: `O(1)`
         * Modes: Pre-existence of `dest`; Post-existence of `source`; Account pre-existence of
         * `dest`.
         */
        force_transfer: TxDescriptor<Anonymize<I5vhombd5v3q3i>>;
        /**
         * Disallow further unprivileged transfers of an asset `id` from an account `who`. `who`
         * must already exist as an entry in `Account`s of the asset. If you want to freeze an
         * account that does not have an entry, use `touch_other` first.
         *
         * Origin must be Signed and the sender should be the Freezer of the asset `id`.
         *
         * - `id`: The identifier of the asset to be frozen.
         * - `who`: The account to be frozen.
         *
         * Emits `Frozen`.
         *
         * Weight: `O(1)`
         */
        freeze: TxDescriptor<Anonymize<Ifn5slgv2scogq>>;
        /**
         * Allow unprivileged transfers to and from an account again.
         *
         * Origin must be Signed and the sender should be the Admin of the asset `id`.
         *
         * - `id`: The identifier of the asset to be frozen.
         * - `who`: The account to be unfrozen.
         *
         * Emits `Thawed`.
         *
         * Weight: `O(1)`
         */
        thaw: TxDescriptor<Anonymize<Ifn5slgv2scogq>>;
        /**
         * Disallow further unprivileged transfers for the asset class.
         *
         * Origin must be Signed and the sender should be the Freezer of the asset `id`.
         *
         * - `id`: The identifier of the asset to be frozen.
         *
         * Emits `Frozen`.
         *
         * Weight: `O(1)`
         */
        freeze_asset: TxDescriptor<Anonymize<I4ov6e94l79mbg>>;
        /**
         * Allow unprivileged transfers for the asset again.
         *
         * Origin must be Signed and the sender should be the Admin of the asset `id`.
         *
         * - `id`: The identifier of the asset to be thawed.
         *
         * Emits `Thawed`.
         *
         * Weight: `O(1)`
         */
        thaw_asset: TxDescriptor<Anonymize<I4ov6e94l79mbg>>;
        /**
         * Change the Owner of an asset.
         *
         * Origin must be Signed and the sender should be the Owner of the asset `id`.
         *
         * - `id`: The identifier of the asset.
         * - `owner`: The new Owner of this asset.
         *
         * Emits `OwnerChanged`.
         *
         * Weight: `O(1)`
         */
        transfer_ownership: TxDescriptor<Anonymize<I2sh1vq7mki6oa>>;
        /**
         * Change the Issuer, Admin and Freezer of an asset.
         *
         * Origin must be Signed and the sender should be the Owner of the asset `id`.
         *
         * - `id`: The identifier of the asset to be frozen.
         * - `issuer`: The new Issuer of this asset.
         * - `admin`: The new Admin of this asset.
         * - `freezer`: The new Freezer of this asset.
         *
         * Emits `TeamChanged`.
         *
         * Weight: `O(1)`
         */
        set_team: TxDescriptor<Anonymize<I2vkf0rft09hc1>>;
        /**
         * Set the metadata for an asset.
         *
         * Origin must be Signed and the sender should be the Owner of the asset `id`.
         *
         * Funds of sender are reserved according to the formula:
         * `MetadataDepositBase + MetadataDepositPerByte * (name.len + symbol.len)` taking into
         * account any already reserved funds.
         *
         * - `id`: The identifier of the asset to update.
         * - `name`: The user friendly name of this asset. Limited in length by `StringLimit`.
         * - `symbol`: The exchange symbol for this asset. Limited in length by `StringLimit`.
         * - `decimals`: The number of decimals this asset uses to represent one unit.
         *
         * Emits `MetadataSet`.
         *
         * Weight: `O(1)`
         */
        set_metadata: TxDescriptor<Anonymize<I87vll2k0a91o2>>;
        /**
         * Clear the metadata for an asset.
         *
         * Origin must be Signed and the sender should be the Owner of the asset `id`.
         *
         * Any deposit is freed for the asset owner.
         *
         * - `id`: The identifier of the asset to clear.
         *
         * Emits `MetadataCleared`.
         *
         * Weight: `O(1)`
         */
        clear_metadata: TxDescriptor<Anonymize<I4ov6e94l79mbg>>;
        /**
         * Force the metadata for an asset to some value.
         *
         * Origin must be ForceOrigin.
         *
         * Any deposit is left alone.
         *
         * - `id`: The identifier of the asset to update.
         * - `name`: The user friendly name of this asset. Limited in length by `StringLimit`.
         * - `symbol`: The exchange symbol for this asset. Limited in length by `StringLimit`.
         * - `decimals`: The number of decimals this asset uses to represent one unit.
         *
         * Emits `MetadataSet`.
         *
         * Weight: `O(N + S)` where N and S are the length of the name and symbol respectively.
         */
        force_set_metadata: TxDescriptor<Anonymize<Iekaug5vo6n1jh>>;
        /**
         * Clear the metadata for an asset.
         *
         * Origin must be ForceOrigin.
         *
         * Any deposit is returned.
         *
         * - `id`: The identifier of the asset to clear.
         *
         * Emits `MetadataCleared`.
         *
         * Weight: `O(1)`
         */
        force_clear_metadata: TxDescriptor<Anonymize<I4ov6e94l79mbg>>;
        /**
         * Alter the attributes of a given asset.
         *
         * Origin must be `ForceOrigin`.
         *
         * - `id`: The identifier of the asset.
         * - `owner`: The new Owner of this asset.
         * - `issuer`: The new Issuer of this asset.
         * - `admin`: The new Admin of this asset.
         * - `freezer`: The new Freezer of this asset.
         * - `min_balance`: The minimum balance of this new asset that any single account must
         * have. If an account's balance is reduced below this, then it collapses to zero.
         * - `is_sufficient`: Whether a non-zero balance of this asset is deposit of sufficient
         * value to account for the state bloat associated with its balance storage. If set to
         * `true`, then non-zero balances may be stored without a `consumer` reference (and thus
         * an ED in the Balances pallet or whatever else is used to control user-account state
         * growth).
         * - `is_frozen`: Whether this asset class is frozen except for permissioned/admin
         * instructions.
         *
         * Emits `AssetStatusChanged` with the identity of the asset.
         *
         * Weight: `O(1)`
         */
        force_asset_status: TxDescriptor<Anonymize<Ie54ng68f2kek5>>;
        /**
         * Approve an amount of asset for transfer by a delegated third-party account.
         *
         * Origin must be Signed.
         *
         * Ensures that `ApprovalDeposit` worth of `Currency` is reserved from signing account
         * for the purpose of holding the approval. If some non-zero amount of assets is already
         * approved from signing account to `delegate`, then it is topped up or unreserved to
         * meet the right value.
         *
         * NOTE: The signing account does not need to own `amount` of assets at the point of
         * making this call.
         *
         * - `id`: The identifier of the asset.
         * - `delegate`: The account to delegate permission to transfer asset.
         * - `amount`: The amount of asset that may be transferred by `delegate`. If there is
         * already an approval in place, then this acts additively.
         *
         * Emits `ApprovedTransfer` on success.
         *
         * Weight: `O(1)`
         */
        approve_transfer: TxDescriptor<Anonymize<I2cjplfh6m2djj>>;
        /**
         * Cancel all of some asset approved for delegated transfer by a third-party account.
         *
         * Origin must be Signed and there must be an approval in place between signer and
         * `delegate`.
         *
         * Unreserves any deposit previously reserved by `approve_transfer` for the approval.
         *
         * - `id`: The identifier of the asset.
         * - `delegate`: The account delegated permission to transfer asset.
         *
         * Emits `ApprovalCancelled` on success.
         *
         * Weight: `O(1)`
         */
        cancel_approval: TxDescriptor<Anonymize<I7efm6ceeotvpk>>;
        /**
         * Cancel all of some asset approved for delegated transfer by a third-party account.
         *
         * Origin must be either ForceOrigin or Signed origin with the signer being the Admin
         * account of the asset `id`.
         *
         * Unreserves any deposit previously reserved by `approve_transfer` for the approval.
         *
         * - `id`: The identifier of the asset.
         * - `delegate`: The account delegated permission to transfer asset.
         *
         * Emits `ApprovalCancelled` on success.
         *
         * Weight: `O(1)`
         */
        force_cancel_approval: TxDescriptor<Anonymize<I2ei6jes8e1vjr>>;
        /**
         * Transfer some asset balance from a previously delegated account to some third-party
         * account.
         *
         * Origin must be Signed and there must be an approval in place by the `owner` to the
         * signer.
         *
         * If the entire amount approved for transfer is transferred, then any deposit previously
         * reserved by `approve_transfer` is unreserved.
         *
         * - `id`: The identifier of the asset.
         * - `owner`: The account which previously approved for a transfer of at least `amount` and
         * from which the asset balance will be withdrawn.
         * - `destination`: The account to which the asset balance of `amount` will be transferred.
         * - `amount`: The amount of assets to transfer.
         *
         * Emits `TransferredApproved` on success.
         *
         * Weight: `O(1)`
         */
        transfer_approved: TxDescriptor<Anonymize<Icquq3o4hcmj65>>;
        /**
         * Create an asset account for non-provider assets.
         *
         * A deposit will be taken from the signer account.
         *
         * - `origin`: Must be Signed; the signer account must have sufficient funds for a deposit
         * to be taken.
         * - `id`: The identifier of the asset for the account to be created.
         *
         * Emits `Touched` event when successful.
         */
        touch: TxDescriptor<Anonymize<I4ov6e94l79mbg>>;
        /**
         * Return the deposit (if any) of an asset account or a consumer reference (if any) of an
         * account.
         *
         * The origin must be Signed.
         *
         * - `id`: The identifier of the asset for which the caller would like the deposit
         * refunded.
         * - `allow_burn`: If `true` then assets may be destroyed in order to complete the refund.
         *
         * Emits `Refunded` event when successful.
         */
        refund: TxDescriptor<Anonymize<Ib98qbv23c0tst>>;
        /**
         * Sets the minimum balance of an asset.
         *
         * Only works if there aren't any accounts that are holding the asset or if
         * the new value of `min_balance` is less than the old one.
         *
         * Origin must be Signed and the sender has to be the Owner of the
         * asset `id`.
         *
         * - `id`: The identifier of the asset.
         * - `min_balance`: The new value of `min_balance`.
         *
         * Emits `AssetMinBalanceChanged` event when successful.
         */
        set_min_balance: TxDescriptor<Anonymize<Iebdnbvufodnev>>;
        /**
         * Create an asset account for `who`.
         *
         * A deposit will be taken from the signer account.
         *
         * - `origin`: Must be Signed by `Freezer` or `Admin` of the asset `id`; the signer account
         * must have sufficient funds for a deposit to be taken.
         * - `id`: The identifier of the asset for the account to be created.
         * - `who`: The account to be created.
         *
         * Emits `Touched` event when successful.
         */
        touch_other: TxDescriptor<Anonymize<Ifn5slgv2scogq>>;
        /**
         * Return the deposit (if any) of a target asset account. Useful if you are the depositor.
         *
         * The origin must be Signed and either the account owner, depositor, or asset `Admin`. In
         * order to burn a non-zero balance of the asset, the caller must be the account and should
         * use `refund`.
         *
         * - `id`: The identifier of the asset for the account holding a deposit.
         * - `who`: The account to refund.
         *
         * Emits `Refunded` event when successful.
         */
        refund_other: TxDescriptor<Anonymize<Ifn5slgv2scogq>>;
        /**
         * Disallow further unprivileged transfers of an asset `id` to and from an account `who`.
         *
         * Origin must be Signed and the sender should be the Freezer of the asset `id`.
         *
         * - `id`: The identifier of the account's asset.
         * - `who`: The account to be unblocked.
         *
         * Emits `Blocked`.
         *
         * Weight: `O(1)`
         */
        block: TxDescriptor<Anonymize<Ifn5slgv2scogq>>;
    };
    Balances: {
        /**
         * Transfer some liquid free balance to another account.
         *
         * `transfer_allow_death` will set the `FreeBalance` of the sender and receiver.
         * If the sender's account is below the existential deposit as a result
         * of the transfer, the account will be reaped.
         *
         * The dispatch origin for this call must be `Signed` by the transactor.
         */
        transfer_allow_death: TxDescriptor<Anonymize<I65i612een2ak>>;
        /**
         * Exactly as `transfer_allow_death`, except the origin must be root and the source account
         * may be specified.
         */
        force_transfer: TxDescriptor<Anonymize<I5vvf47ira6s09>>;
        /**
         * Same as the [`transfer_allow_death`] call, but with a check that the transfer will not
         * kill the origin account.
         *
         * 99% of the time you want [`transfer_allow_death`] instead.
         *
         * [`transfer_allow_death`]: struct.Pallet.html#method.transfer
         */
        transfer_keep_alive: TxDescriptor<Anonymize<I65i612een2ak>>;
        /**
         * Transfer the entire transferable balance from the caller account.
         *
         * NOTE: This function only attempts to transfer _transferable_ balances. This means that
         * any locked, reserved, or existential deposits (when `keep_alive` is `true`), will not be
         * transferred by this function. To ensure that this function results in a killed account,
         * you might need to prepare the account by removing any reference counters, storage
         * deposits, etc...
         *
         * The dispatch origin of this call must be Signed.
         *
         * - `dest`: The recipient of the transfer.
         * - `keep_alive`: A boolean to determine if the `transfer_all` operation should send all
         * of the funds the account has, causing the sender account to be killed (false), or
         * transfer everything except at least the existential deposit, which will guarantee to
         * keep the sender account alive (true).
         */
        transfer_all: TxDescriptor<Anonymize<I5ns79ftlq8cnl>>;
        /**
         * Unreserve some balance from a user by force.
         *
         * Can only be called by ROOT.
         */
        force_unreserve: TxDescriptor<Anonymize<I59ofijoau4bjh>>;
        /**
         * Upgrade a specified account.
         *
         * - `origin`: Must be `Signed`.
         * - `who`: The account to be upgraded.
         *
         * This will waive the transaction fee if at least all but 10% of the accounts needed to
         * be upgraded. (We let some not have to be upgraded just in order to allow for the
         * possibility of churn).
         */
        upgrade_accounts: TxDescriptor<Anonymize<Ibmr18suc9ikh9>>;
        /**
         * Set the regular balance of a given account.
         *
         * The dispatch origin for this call is `root`.
         */
        force_set_balance: TxDescriptor<Anonymize<Ieka2e164ntfss>>;
        /**
         * Adjust the total issuance in a saturating way.
         *
         * Can only be called by root and always needs a positive `delta`.
         *
         * # Example
         */
        force_adjust_total_issuance: TxDescriptor<Anonymize<I5u8olqbbvfnvf>>;
        /**
         * Burn the specified liquid free balance from the origin account.
         *
         * If the origin's account ends up below the existential deposit as a result
         * of the burn and `keep_alive` is false, the account will be reaped.
         *
         * Unlike sending funds to a _burn_ address, which merely makes the funds inaccessible,
         * this `burn` operation will reduce total issuance by the amount _burned_.
         */
        burn: TxDescriptor<Anonymize<I5utcetro501ir>>;
    };
    Babe: {
        /**
         * Report authority equivocation/misbehavior. This method will verify
         * the equivocation proof and validate the given key ownership proof
         * against the extracted offender. If both are valid, the offence will
         * be reported.
         */
        report_equivocation: TxDescriptor<Anonymize<I5tnpomjhli8ea>>;
        /**
         * Report authority equivocation/misbehavior. This method will verify
         * the equivocation proof and validate the given key ownership proof
         * against the extracted offender. If both are valid, the offence will
         * be reported.
         * This extrinsic must be called unsigned and it is expected that only
         * block authors will call it (validated in `ValidateUnsigned`), as such
         * if the block author is defined it will be defined as the equivocation
         * reporter.
         */
        report_equivocation_unsigned: TxDescriptor<Anonymize<I5tnpomjhli8ea>>;
        /**
         * Plan an epoch config change. The epoch config change is recorded and will be enacted on
         * the next call to `enact_epoch_change`. The config will be activated one epoch after.
         * Multiple calls to this method will replace any existing planned config change that had
         * not been enacted yet.
         */
        plan_config_change: TxDescriptor<Anonymize<I9fin09kkg0jaj>>;
    };
    Grandpa: {
        /**
         * Report voter equivocation/misbehavior. This method will verify the
         * equivocation proof and validate the given key ownership proof
         * against the extracted offender. If both are valid, the offence
         * will be reported.
         */
        report_equivocation: TxDescriptor<Anonymize<Iar76998r89ou1>>;
        /**
         * Report voter equivocation/misbehavior. This method will verify the
         * equivocation proof and validate the given key ownership proof
         * against the extracted offender. If both are valid, the offence
         * will be reported.
         *
         * This extrinsic must be called unsigned and it is expected that only
         * block authors will call it (validated in `ValidateUnsigned`), as such
         * if the block author is defined it will be defined as the equivocation
         * reporter.
         */
        report_equivocation_unsigned: TxDescriptor<Anonymize<Iar76998r89ou1>>;
        /**
         * Note that the current authority set of the GRANDPA finality gadget has stalled.
         *
         * This will trigger a forced authority set change at the beginning of the next session, to
         * be enacted `delay` blocks after that. The `delay` should be high enough to safely assume
         * that the block signalling the forced change will not be re-orged e.g. 1000 blocks.
         * The block production rate (which may be slowed down because of finality lagging) should
         * be taken into account when choosing the `delay`. The GRANDPA voters based on the new
         * authority will start voting on top of `best_finalized_block_number` for new finalized
         * blocks. `best_finalized_block_number` should be the highest of the latest finalized
         * block of all validators of the new authority set.
         *
         * Only callable by root.
         */
        note_stalled: TxDescriptor<Anonymize<Ichu6a94bm67kd>>;
    };
    Indices: {
        /**
         * Assign an previously unassigned index.
         *
         * Payment: `Deposit` is reserved from the sender account.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * - `index`: the index to be claimed. This must not be in use.
         *
         * Emits `IndexAssigned` if successful.
         *
         * ## Complexity
         * - `O(1)`.
         */
        claim: TxDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * Assign an index already owned by the sender to another account. The balance reservation
         * is effectively transferred to the new account.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * - `index`: the index to be re-assigned. This must be owned by the sender.
         * - `new`: the new owner of the index. This function is a no-op if it is equal to sender.
         *
         * Emits `IndexAssigned` if successful.
         *
         * ## Complexity
         * - `O(1)`.
         */
        transfer: TxDescriptor<Anonymize<I1u3ac7lafvv5b>>;
        /**
         * Free up an index owned by the sender.
         *
         * Payment: Any previous deposit placed for the index is unreserved in the sender account.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must own the index.
         *
         * - `index`: the index to be freed. This must be owned by the sender.
         *
         * Emits `IndexFreed` if successful.
         *
         * ## Complexity
         * - `O(1)`.
         */
        free: TxDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * Force an index to an account. This doesn't require a deposit. If the index is already
         * held, then any deposit is reimbursed to its current owner.
         *
         * The dispatch origin for this call must be _Root_.
         *
         * - `index`: the index to be (re-)assigned.
         * - `new`: the new owner of the index. This function is a no-op if it is equal to sender.
         * - `freeze`: if set to `true`, will freeze the index so it cannot be transferred.
         *
         * Emits `IndexAssigned` if successful.
         *
         * ## Complexity
         * - `O(1)`.
         */
        force_transfer: TxDescriptor<Anonymize<I5teebeg0opib2>>;
        /**
         * Freeze an index so it will always point to the sender account. This consumes the
         * deposit.
         *
         * The dispatch origin for this call must be _Signed_ and the signing account must have a
         * non-frozen account `index`.
         *
         * - `index`: the index to be frozen in place.
         *
         * Emits `IndexFrozen` if successful.
         *
         * ## Complexity
         * - `O(1)`.
         */
        freeze: TxDescriptor<Anonymize<I666bl2fqjkejo>>;
    };
    Democracy: {
        /**
         * Propose a sensitive action to be taken.
         *
         * The dispatch origin of this call must be _Signed_ and the sender must
         * have funds to cover the deposit.
         *
         * - `proposal_hash`: The hash of the proposal preimage.
         * - `value`: The amount of deposit (must be at least `MinimumDeposit`).
         *
         * Emits `Proposed`.
         */
        propose: TxDescriptor<Anonymize<I1moso5oagpiea>>;
        /**
         * Signals agreement with a particular proposal.
         *
         * The dispatch origin of this call must be _Signed_ and the sender
         * must have funds to cover the deposit, equal to the original deposit.
         *
         * - `proposal`: The index of the proposal to second.
         */
        second: TxDescriptor<Anonymize<Ibeb4n9vpjefp3>>;
        /**
         * Vote in a referendum. If `vote.is_aye()`, the vote is to enact the proposal;
         * otherwise it is a vote to keep the status quo.
         *
         * The dispatch origin of this call must be _Signed_.
         *
         * - `ref_index`: The index of the referendum to vote for.
         * - `vote`: The vote configuration.
         */
        vote: TxDescriptor<Anonymize<Id7murq9s9fg6h>>;
        /**
         * Schedule an emergency cancellation of a referendum. Cannot happen twice to the same
         * referendum.
         *
         * The dispatch origin of this call must be `CancellationOrigin`.
         *
         * -`ref_index`: The index of the referendum to cancel.
         *
         * Weight: `O(1)`.
         */
        emergency_cancel: TxDescriptor<Anonymize<Ied9mja4bq7va8>>;
        /**
         * Schedule a referendum to be tabled once it is legal to schedule an external
         * referendum.
         *
         * The dispatch origin of this call must be `ExternalOrigin`.
         *
         * - `proposal_hash`: The preimage hash of the proposal.
         */
        external_propose: TxDescriptor<Anonymize<I4f7jul8ljs54r>>;
        /**
         * Schedule a majority-carries referendum to be tabled next once it is legal to schedule
         * an external referendum.
         *
         * The dispatch of this call must be `ExternalMajorityOrigin`.
         *
         * - `proposal_hash`: The preimage hash of the proposal.
         *
         * Unlike `external_propose`, blacklisting has no effect on this and it may replace a
         * pre-scheduled `external_propose` call.
         *
         * Weight: `O(1)`
         */
        external_propose_majority: TxDescriptor<Anonymize<I4f7jul8ljs54r>>;
        /**
         * Schedule a negative-turnout-bias referendum to be tabled next once it is legal to
         * schedule an external referendum.
         *
         * The dispatch of this call must be `ExternalDefaultOrigin`.
         *
         * - `proposal_hash`: The preimage hash of the proposal.
         *
         * Unlike `external_propose`, blacklisting has no effect on this and it may replace a
         * pre-scheduled `external_propose` call.
         *
         * Weight: `O(1)`
         */
        external_propose_default: TxDescriptor<Anonymize<I4f7jul8ljs54r>>;
        /**
         * Schedule the currently externally-proposed majority-carries referendum to be tabled
         * immediately. If there is no externally-proposed referendum currently, or if there is one
         * but it is not a majority-carries referendum then it fails.
         *
         * The dispatch of this call must be `FastTrackOrigin`.
         *
         * - `proposal_hash`: The hash of the current external proposal.
         * - `voting_period`: The period that is allowed for voting on this proposal. Increased to
         * Must be always greater than zero.
         * For `FastTrackOrigin` must be equal or greater than `FastTrackVotingPeriod`.
         * - `delay`: The number of block after voting has ended in approval and this should be
         * enacted. This doesn't have a minimum amount.
         *
         * Emits `Started`.
         *
         * Weight: `O(1)`
         */
        fast_track: TxDescriptor<Anonymize<I1gk9fmne451rl>>;
        /**
         * Veto and blacklist the external proposal hash.
         *
         * The dispatch origin of this call must be `VetoOrigin`.
         *
         * - `proposal_hash`: The preimage hash of the proposal to veto and blacklist.
         *
         * Emits `Vetoed`.
         *
         * Weight: `O(V + log(V))` where V is number of `existing vetoers`
         */
        veto_external: TxDescriptor<Anonymize<I2ev73t79f46tb>>;
        /**
         * Remove a referendum.
         *
         * The dispatch origin of this call must be _Root_.
         *
         * - `ref_index`: The index of the referendum to cancel.
         *
         * # Weight: `O(1)`.
         */
        cancel_referendum: TxDescriptor<Anonymize<Ied9mja4bq7va8>>;
        /**
         * Delegate the voting power (with some given conviction) of the sending account.
         *
         * The balance delegated is locked for as long as it's delegated, and thereafter for the
         * time appropriate for the conviction's lock period.
         *
         * The dispatch origin of this call must be _Signed_, and the signing account must either:
         * - be delegating already; or
         * - have no voting activity (if there is, then it will need to be removed/consolidated
         * through `reap_vote` or `unvote`).
         *
         * - `to`: The account whose voting the `target` account's voting power will follow.
         * - `conviction`: The conviction that will be attached to the delegated votes. When the
         * account is undelegated, the funds will be locked for the corresponding period.
         * - `balance`: The amount of the account's balance to be used in delegating. This must not
         * be more than the account's current balance.
         *
         * Emits `Delegated`.
         *
         * Weight: `O(R)` where R is the number of referendums the voter delegating to has
         * voted on. Weight is charged as if maximum votes.
         */
        delegate: TxDescriptor<Anonymize<I1736r1jp6plpc>>;
        /**
         * Undelegate the voting power of the sending account.
         *
         * Tokens may be unlocked following once an amount of time consistent with the lock period
         * of the conviction with which the delegation was issued.
         *
         * The dispatch origin of this call must be _Signed_ and the signing account must be
         * currently delegating.
         *
         * Emits `Undelegated`.
         *
         * Weight: `O(R)` where R is the number of referendums the voter delegating to has
         * voted on. Weight is charged as if maximum votes.
         */
        undelegate: TxDescriptor<undefined>;
        /**
         * Clears all public proposals.
         *
         * The dispatch origin of this call must be _Root_.
         *
         * Weight: `O(1)`.
         */
        clear_public_proposals: TxDescriptor<undefined>;
        /**
         * Unlock tokens that have an expired lock.
         *
         * The dispatch origin of this call must be _Signed_.
         *
         * - `target`: The account to remove the lock on.
         *
         * Weight: `O(R)` with R number of vote of target.
         */
        unlock: TxDescriptor<Anonymize<If31vrl50nund3>>;
        /**
         * Remove a vote for a referendum.
         *
         * If:
         * - the referendum was cancelled, or
         * - the referendum is ongoing, or
         * - the referendum has ended such that
         * - the vote of the account was in opposition to the result; or
         * - there was no conviction to the account's vote; or
         * - the account made a split vote
         * ...then the vote is removed cleanly and a following call to `unlock` may result in more
         * funds being available.
         *
         * If, however, the referendum has ended and:
         * - it finished corresponding to the vote of the account, and
         * - the account made a standard vote with conviction, and
         * - the lock period of the conviction is not over
         * ...then the lock will be aggregated into the overall account's lock, which may involve
         * *overlocking* (where the two locks are combined into a single lock that is the maximum
         * of both the amount locked and the time is it locked for).
         *
         * The dispatch origin of this call must be _Signed_, and the signer must have a vote
         * registered for referendum `index`.
         *
         * - `index`: The index of referendum of the vote to be removed.
         *
         * Weight: `O(R + log R)` where R is the number of referenda that `target` has voted on.
         * Weight is calculated for the maximum number of vote.
         */
        remove_vote: TxDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * Remove a vote for a referendum.
         *
         * If the `target` is equal to the signer, then this function is exactly equivalent to
         * `remove_vote`. If not equal to the signer, then the vote must have expired,
         * either because the referendum was cancelled, because the voter lost the referendum or
         * because the conviction period is over.
         *
         * The dispatch origin of this call must be _Signed_.
         *
         * - `target`: The account of the vote to be removed; this account must have voted for
         * referendum `index`.
         * - `index`: The index of referendum of the vote to be removed.
         *
         * Weight: `O(R + log R)` where R is the number of referenda that `target` has voted on.
         * Weight is calculated for the maximum number of vote.
         */
        remove_other_vote: TxDescriptor<Anonymize<I6s1n1athh0bbq>>;
        /**
         * Permanently place a proposal into the blacklist. This prevents it from ever being
         * proposed again.
         *
         * If called on a queued public or external proposal, then this will result in it being
         * removed. If the `ref_index` supplied is an active referendum with the proposal hash,
         * then it will be cancelled.
         *
         * The dispatch origin of this call must be `BlacklistOrigin`.
         *
         * - `proposal_hash`: The proposal hash to blacklist permanently.
         * - `ref_index`: An ongoing referendum whose hash is `proposal_hash`, which will be
         * cancelled.
         *
         * Weight: `O(p)` (though as this is an high-privilege dispatch, we assume it has a
         * reasonable value).
         */
        blacklist: TxDescriptor<Anonymize<I3v9h9f3mpm1l8>>;
        /**
         * Remove a proposal.
         *
         * The dispatch origin of this call must be `CancelProposalOrigin`.
         *
         * - `prop_index`: The index of the proposal to cancel.
         *
         * Weight: `O(p)` where `p = PublicProps::<T>::decode_len()`
         */
        cancel_proposal: TxDescriptor<Anonymize<I9mnj4k4u8ls2c>>;
        /**
         * Set or clear a metadata of a proposal or a referendum.
         *
         * Parameters:
         * - `origin`: Must correspond to the `MetadataOwner`.
         * - `ExternalOrigin` for an external proposal with the `SuperMajorityApprove`
         * threshold.
         * - `ExternalDefaultOrigin` for an external proposal with the `SuperMajorityAgainst`
         * threshold.
         * - `ExternalMajorityOrigin` for an external proposal with the `SimpleMajority`
         * threshold.
         * - `Signed` by a creator for a public proposal.
         * - `Signed` to clear a metadata for a finished referendum.
         * - `Root` to set a metadata for an ongoing referendum.
         * - `owner`: an identifier of a metadata owner.
         * - `maybe_hash`: The hash of an on-chain stored preimage. `None` to clear a metadata.
         */
        set_metadata: TxDescriptor<Anonymize<I2kt2u1flctk2q>>;
    };
    Council: {
        /**
         * Set the collective's membership.
         *
         * - `new_members`: The new member list. Be nice to the chain and provide it sorted.
         * - `prime`: The prime member whose vote sets the default.
         * - `old_count`: The upper bound for the previous number of members in storage. Used for
         * weight estimation.
         *
         * The dispatch of this call must be `SetMembersOrigin`.
         *
         * NOTE: Does not enforce the expected `MaxMembers` limit on the amount of members, but
         * the weight estimations rely on it to estimate dispatchable weight.
         *
         * # WARNING:
         *
         * The `pallet-collective` can also be managed by logic outside of the pallet through the
         * implementation of the trait [`ChangeMembers`].
         * Any call to `set_members` must be careful that the member set doesn't get out of sync
         * with other logic managing the member set.
         *
         * ## Complexity:
         * - `O(MP + N)` where:
         * - `M` old-members-count (code- and governance-bounded)
         * - `N` new-members-count (code- and governance-bounded)
         * - `P` proposals-count (code-bounded)
         */
        set_members: TxDescriptor<Anonymize<I38jfk5li8iang>>;
        /**
         * Dispatch a proposal from a member using the `Member` origin.
         *
         * Origin must be a member of the collective.
         *
         * ## Complexity:
         * - `O(B + M + P)` where:
         * - `B` is `proposal` size in bytes (length-fee-bounded)
         * - `M` members-count (code-bounded)
         * - `P` complexity of dispatching `proposal`
         */
        execute: TxDescriptor<Anonymize<If9uk9cppuuifi>>;
        /**
         * Add a new proposal to either be voted on or executed directly.
         *
         * Requires the sender to be member.
         *
         * `threshold` determines whether `proposal` is executed directly (`threshold < 2`)
         * or put up for voting.
         *
         * ## Complexity
         * - `O(B + M + P1)` or `O(B + M + P2)` where:
         * - `B` is `proposal` size in bytes (length-fee-bounded)
         * - `M` is members-count (code- and governance-bounded)
         * - branching is influenced by `threshold` where:
         * - `P1` is proposal execution complexity (`threshold < 2`)
         * - `P2` is proposals-count (code-bounded) (`threshold >= 2`)
         */
        propose: TxDescriptor<Anonymize<I9q0ensvnonfmg>>;
        /**
         * Add an aye or nay vote for the sender to the given proposal.
         *
         * Requires the sender to be a member.
         *
         * Transaction fees will be waived if the member is voting on any particular proposal
         * for the first time and the call is successful. Subsequent vote changes will charge a
         * fee.
         * ## Complexity
         * - `O(M)` where `M` is members-count (code- and governance-bounded)
         */
        vote: TxDescriptor<Anonymize<I2dtrijkm5601t>>;
        /**
         * Disapprove a proposal, close, and remove it from the system, regardless of its current
         * state.
         *
         * Must be called by the Root origin.
         *
         * Parameters:
         * * `proposal_hash`: The hash of the proposal that should be disapproved.
         *
         * ## Complexity
         * O(P) where P is the number of max proposals
         */
        disapprove_proposal: TxDescriptor<Anonymize<I2ev73t79f46tb>>;
        /**
         * Close a vote that is either approved, disapproved or whose voting period has ended.
         *
         * May be called by any signed account in order to finish voting and close the proposal.
         *
         * If called before the end of the voting period it will only close the vote if it is
         * has enough votes to be approved or disapproved.
         *
         * If called after the end of the voting period abstentions are counted as rejections
         * unless there is a prime member set and the prime member cast an approval.
         *
         * If the close operation completes successfully with disapproval, the transaction fee will
         * be waived. Otherwise execution of the approved operation will be charged to the caller.
         *
         * + `proposal_weight_bound`: The maximum amount of weight consumed by executing the closed
         * proposal.
         * + `length_bound`: The upper bound for the length of the proposal in storage. Checked via
         * `storage::read` so it is `size_of::<u32>() == 4` larger than the pure length.
         *
         * ## Complexity
         * - `O(B + M + P1 + P2)` where:
         * - `B` is `proposal` size in bytes (length-fee-bounded)
         * - `M` is members-count (code- and governance-bounded)
         * - `P1` is the complexity of `proposal` preimage.
         * - `P2` is proposal-count (code-bounded)
         */
        close: TxDescriptor<Anonymize<Ib2obgji960euh>>;
    };
    Vesting: {
        /**
         * Unlock any vested funds of the sender account.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must have funds still
         * locked under this pallet.
         *
         * Emits either `VestingCompleted` or `VestingUpdated`.
         *
         * ## Complexity
         * - `O(1)`.
         */
        vest: TxDescriptor<undefined>;
        /**
         * Unlock any vested funds of a `target` account.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * - `target`: The account whose vested funds should be unlocked. Must have funds still
         * locked under this pallet.
         *
         * Emits either `VestingCompleted` or `VestingUpdated`.
         *
         * ## Complexity
         * - `O(1)`.
         */
        vest_other: TxDescriptor<Anonymize<If31vrl50nund3>>;
        /**
         * Create a vested transfer.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * - `target`: The account receiving the vested funds.
         * - `schedule`: The vesting schedule attached to the transfer.
         *
         * Emits `VestingCreated`.
         *
         * NOTE: This will unlock all schedules through the current block.
         *
         * ## Complexity
         * - `O(1)`.
         */
        vested_transfer: TxDescriptor<Anonymize<Icviohnuu9eu8b>>;
        /**
         * Force a vested transfer.
         *
         * The dispatch origin for this call must be _Root_.
         *
         * - `source`: The account whose funds should be transferred.
         * - `target`: The account that should be transferred the vested funds.
         * - `schedule`: The vesting schedule attached to the transfer.
         *
         * Emits `VestingCreated`.
         *
         * NOTE: This will unlock all schedules through the current block.
         *
         * ## Complexity
         * - `O(1)`.
         */
        force_vested_transfer: TxDescriptor<Anonymize<I780ptnqsedf69>>;
        /**
         * Merge two vesting schedules together, creating a new vesting schedule that unlocks over
         * the highest possible start and end blocks. If both schedules have already started the
         * current block will be used as the schedule start; with the caveat that if one schedule
         * is finished by the current block, the other will be treated as the new merged schedule,
         * unmodified.
         *
         * NOTE: If `schedule1_index == schedule2_index` this is a no-op.
         * NOTE: This will unlock all schedules through the current block prior to merging.
         * NOTE: If both schedules have ended by the current block, no new schedule will be created
         * and both will be removed.
         *
         * Merged schedule attributes:
         * - `starting_block`: `MAX(schedule1.starting_block, scheduled2.starting_block,
         * current_block)`.
         * - `ending_block`: `MAX(schedule1.ending_block, schedule2.ending_block)`.
         * - `locked`: `schedule1.locked_at(current_block) + schedule2.locked_at(current_block)`.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * - `schedule1_index`: index of the first schedule to merge.
         * - `schedule2_index`: index of the second schedule to merge.
         */
        merge_schedules: TxDescriptor<Anonymize<Ict9ivhr2c5hv0>>;
        /**
         * Force remove a vesting schedule
         *
         * The dispatch origin for this call must be _Root_.
         *
         * - `target`: An account that has a vesting schedule
         * - `schedule_index`: The vesting schedule index that should be removed
         */
        force_remove_vesting_schedule: TxDescriptor<Anonymize<Ia5huiefjr1uhk>>;
    };
    Elections: {
        /**
         * Vote for a set of candidates for the upcoming round of election. This can be called to
         * set the initial votes, or update already existing votes.
         *
         * Upon initial voting, `value` units of `who`'s balance is locked and a deposit amount is
         * reserved. The deposit is based on the number of votes and can be updated over time.
         *
         * The `votes` should:
         * - not be empty.
         * - be less than the number of possible candidates. Note that all current members and
         * runners-up are also automatically candidates for the next round.
         *
         * If `value` is more than `who`'s free balance, then the maximum of the two is used.
         *
         * The dispatch origin of this call must be signed.
         *
         * ### Warning
         *
         * It is the responsibility of the caller to **NOT** place all of their balance into the
         * lock and keep some for further operations.
         */
        vote: TxDescriptor<Anonymize<Iaa13icjlsj13d>>;
        /**
         * Remove `origin` as a voter.
         *
         * This removes the lock and returns the deposit.
         *
         * The dispatch origin of this call must be signed and be a voter.
         */
        remove_voter: TxDescriptor<undefined>;
        /**
         * Submit oneself for candidacy. A fixed amount of deposit is recorded.
         *
         * All candidates are wiped at the end of the term. They either become a member/runner-up,
         * or leave the system while their deposit is slashed.
         *
         * The dispatch origin of this call must be signed.
         *
         * ### Warning
         *
         * Even if a candidate ends up being a member, they must call [`Call::renounce_candidacy`]
         * to get their deposit back. Losing the spot in an election will always lead to a slash.
         *
         * The number of current candidates must be provided as witness data.
         * ## Complexity
         * O(C + log(C)) where C is candidate_count.
         */
        submit_candidacy: TxDescriptor<Anonymize<I98vh5ccjtf1ev>>;
        /**
         * Renounce one's intention to be a candidate for the next election round. 3 potential
         * outcomes exist:
         *
         * - `origin` is a candidate and not elected in any set. In this case, the deposit is
         * unreserved, returned and origin is removed as a candidate.
         * - `origin` is a current runner-up. In this case, the deposit is unreserved, returned and
         * origin is removed as a runner-up.
         * - `origin` is a current member. In this case, the deposit is unreserved and origin is
         * removed as a member, consequently not being a candidate for the next round anymore.
         * Similar to [`remove_member`](Self::remove_member), if replacement runners exists, they
         * are immediately used. If the prime is renouncing, then no prime will exist until the
         * next round.
         *
         * The dispatch origin of this call must be signed, and have one of the above roles.
         * The type of renouncing must be provided as witness data.
         *
         * ## Complexity
         * - Renouncing::Candidate(count): O(count + log(count))
         * - Renouncing::Member: O(1)
         * - Renouncing::RunnerUp: O(1)
         */
        renounce_candidacy: TxDescriptor<Anonymize<I3al0eab2u0gt2>>;
        /**
         * Remove a particular member from the set. This is effective immediately and the bond of
         * the outgoing member is slashed.
         *
         * If a runner-up is available, then the best runner-up will be removed and replaces the
         * outgoing member. Otherwise, if `rerun_election` is `true`, a new phragmen election is
         * started, else, nothing happens.
         *
         * If `slash_bond` is set to true, the bond of the member being removed is slashed. Else,
         * it is returned.
         *
         * The dispatch origin of this call must be root.
         *
         * Note that this does not affect the designated block number of the next election.
         *
         * ## Complexity
         * - Check details of remove_and_replace_member() and do_phragmen().
         */
        remove_member: TxDescriptor<Anonymize<Ib3prtfc334m1t>>;
        /**
         * Clean all voters who are defunct (i.e. they do not serve any purpose at all). The
         * deposit of the removed voters are returned.
         *
         * This is an root function to be used only for cleaning the state.
         *
         * The dispatch origin of this call must be root.
         *
         * ## Complexity
         * - Check is_defunct_voter() details.
         */
        clean_defunct_voters: TxDescriptor<Anonymize<I6fuug4i4r04hi>>;
    };
    ElectionProviderMultiPhase: {
        /**
         * Submit a solution for the unsigned phase.
         *
         * The dispatch origin fo this call must be __none__.
         *
         * This submission is checked on the fly. Moreover, this unsigned solution is only
         * validated when submitted to the pool from the **local** node. Effectively, this means
         * that only active validators can submit this transaction when authoring a block (similar
         * to an inherent).
         *
         * To prevent any incorrect solution (and thus wasted time/weight), this transaction will
         * panic if the solution submitted by the validator is invalid in any way, effectively
         * putting their authoring reward at risk.
         *
         * No deposit or reward is associated with this submission.
         */
        submit_unsigned: TxDescriptor<Anonymize<I31k9f0jol8ko4>>;
        /**
         * Set a new value for `MinimumUntrustedScore`.
         *
         * Dispatch origin must be aligned with `T::ForceOrigin`.
         *
         * This check can be turned off by setting the value to `None`.
         */
        set_minimum_untrusted_score: TxDescriptor<Anonymize<I80q14um2s2ckg>>;
        /**
         * Set a solution in the queue, to be handed out to the client of this pallet in the next
         * call to `ElectionProvider::elect`.
         *
         * This can only be set by `T::ForceOrigin`, and only when the phase is `Emergency`.
         *
         * The solution is not checked for any feasibility and is assumed to be trustworthy, as any
         * feasibility check itself can in principle cause the election process to fail (due to
         * memory/weight constrains).
         */
        set_emergency_election_result: TxDescriptor<Anonymize<I5qs1t1erfi7u8>>;
        /**
         * Submit a solution for the signed phase.
         *
         * The dispatch origin fo this call must be __signed__.
         *
         * The solution is potentially queued, based on the claimed score and processed at the end
         * of the signed phase.
         *
         * A deposit is reserved and recorded for the solution. Based on the outcome, the solution
         * might be rewarded, slashed, or get all or a part of the deposit back.
         */
        submit: TxDescriptor<Anonymize<I9et13knvdvgpb>>;
        /**
         * Trigger the governance fallback.
         *
         * This can only be called when [`Phase::Emergency`] is enabled, as an alternative to
         * calling [`Call::set_emergency_election_result`].
         */
        governance_fallback: TxDescriptor<Anonymize<Ifsme8miqq9006>>;
    };
    Staking: {
        /**
         * Take the origin account as a stash and lock up `value` of its balance. `controller` will
         * be the account that controls it.
         *
         * `value` must be more than the `minimum_balance` specified by `T::Currency`.
         *
         * The dispatch origin for this call must be _Signed_ by the stash account.
         *
         * Emits `Bonded`.
         * ## Complexity
         * - Independent of the arguments. Moderate complexity.
         * - O(1).
         * - Three extra DB entries.
         *
         * NOTE: Two of the storage writes (`Self::bonded`, `Self::payee`) are _never_ cleaned
         * unless the `origin` falls below _existential deposit_ (or equal to 0) and gets removed
         * as dust.
         */
        bond: TxDescriptor<Anonymize<I2eip8tc75dpje>>;
        /**
         * Add some extra amount that have appeared in the stash `free_balance` into the balance up
         * for staking.
         *
         * The dispatch origin for this call must be _Signed_ by the stash, not the controller.
         *
         * Use this if there are additional funds in your stash account that you wish to bond.
         * Unlike [`bond`](Self::bond) or [`unbond`](Self::unbond) this function does not impose
         * any limitation on the amount that can be added.
         *
         * Emits `Bonded`.
         *
         * ## Complexity
         * - Independent of the arguments. Insignificant complexity.
         * - O(1).
         */
        bond_extra: TxDescriptor<Anonymize<I564va64vtidbq>>;
        /**
         * Schedule a portion of the stash to be unlocked ready for transfer out after the bond
         * period ends. If this leaves an amount actively bonded less than
         * T::Currency::minimum_balance(), then it is increased to the full amount.
         *
         * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
         *
         * Once the unlock period is done, you can call `withdraw_unbonded` to actually move
         * the funds out of management ready for transfer.
         *
         * No more than a limited number of unlocking chunks (see `MaxUnlockingChunks`)
         * can co-exists at the same time. If there are no unlocking chunks slots available
         * [`Call::withdraw_unbonded`] is called to remove some of the chunks (if possible).
         *
         * If a user encounters the `InsufficientBond` error when calling this extrinsic,
         * they should call `chill` first in order to free up their bonded funds.
         *
         * Emits `Unbonded`.
         *
         * See also [`Call::withdraw_unbonded`].
         */
        unbond: TxDescriptor<Anonymize<Ie5v6njpckr05b>>;
        /**
         * Remove any unlocked chunks from the `unlocking` queue from our management.
         *
         * This essentially frees up that balance to be used by the stash account to do whatever
         * it wants.
         *
         * The dispatch origin for this call must be _Signed_ by the controller.
         *
         * Emits `Withdrawn`.
         *
         * See also [`Call::unbond`].
         *
         * ## Parameters
         *
         * - `num_slashing_spans` indicates the number of metadata slashing spans to clear when
         * this call results in a complete removal of all the data related to the stash account.
         * In this case, the `num_slashing_spans` must be larger or equal to the number of
         * slashing spans associated with the stash account in the [`SlashingSpans`] storage type,
         * otherwise the call will fail. The call weight is directly proportional to
         * `num_slashing_spans`.
         *
         * ## Complexity
         * O(S) where S is the number of slashing spans to remove
         * NOTE: Weight annotation is the kill scenario, we refund otherwise.
         */
        withdraw_unbonded: TxDescriptor<Anonymize<I328av3j0bgmjb>>;
        /**
         * Declare the desire to validate for the origin controller.
         *
         * Effects will be felt at the beginning of the next era.
         *
         * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
         */
        validate: TxDescriptor<Anonymize<I4tuqm9ato907i>>;
        /**
         * Declare the desire to nominate `targets` for the origin controller.
         *
         * Effects will be felt at the beginning of the next era.
         *
         * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
         *
         * ## Complexity
         * - The transaction's complexity is proportional to the size of `targets` (N)
         * which is capped at CompactAssignments::LIMIT (T::MaxNominations).
         * - Both the reads and writes follow a similar pattern.
         */
        nominate: TxDescriptor<Anonymize<I19iomcbdrerea>>;
        /**
         * Declare no desire to either validate or nominate.
         *
         * Effects will be felt at the beginning of the next era.
         *
         * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
         *
         * ## Complexity
         * - Independent of the arguments. Insignificant complexity.
         * - Contains one read.
         * - Writes are limited to the `origin` account key.
         */
        chill: TxDescriptor<undefined>;
        /**
         * (Re-)set the payment target for a controller.
         *
         * Effects will be felt instantly (as soon as this function is completed successfully).
         *
         * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
         *
         * ## Complexity
         * - O(1)
         * - Independent of the arguments. Insignificant complexity.
         * - Contains a limited number of reads.
         * - Writes are limited to the `origin` account key.
         * ---------
         */
        set_payee: TxDescriptor<Anonymize<I9dgmcnuamt5p8>>;
        /**
         * (Re-)sets the controller of a stash to the stash itself. This function previously
         * accepted a `controller` argument to set the controller to an account other than the
         * stash itself. This functionality has now been removed, now only setting the controller
         * to the stash, if it is not already.
         *
         * Effects will be felt instantly (as soon as this function is completed successfully).
         *
         * The dispatch origin for this call must be _Signed_ by the stash, not the controller.
         *
         * ## Complexity
         * O(1)
         * - Independent of the arguments. Insignificant complexity.
         * - Contains a limited number of reads.
         * - Writes are limited to the `origin` account key.
         */
        set_controller: TxDescriptor<undefined>;
        /**
         * Sets the ideal number of validators.
         *
         * The dispatch origin must be Root.
         *
         * ## Complexity
         * O(1)
         */
        set_validator_count: TxDescriptor<Anonymize<I3vh014cqgmrfd>>;
        /**
         * Increments the ideal number of validators up to maximum of
         * `ElectionProviderBase::MaxWinners`.
         *
         * The dispatch origin must be Root.
         *
         * ## Complexity
         * Same as [`Self::set_validator_count`].
         */
        increase_validator_count: TxDescriptor<Anonymize<Ifhs60omlhvt3>>;
        /**
         * Scale up the ideal number of validators by a factor up to maximum of
         * `ElectionProviderBase::MaxWinners`.
         *
         * The dispatch origin must be Root.
         *
         * ## Complexity
         * Same as [`Self::set_validator_count`].
         */
        scale_validator_count: TxDescriptor<Anonymize<If34udpd5e57vi>>;
        /**
         * Force there to be no new eras indefinitely.
         *
         * The dispatch origin must be Root.
         *
         * # Warning
         *
         * The election process starts multiple blocks before the end of the era.
         * Thus the election process may be ongoing when this is called. In this case the
         * election will continue until the next era is triggered.
         *
         * ## Complexity
         * - No arguments.
         * - Weight: O(1)
         */
        force_no_eras: TxDescriptor<undefined>;
        /**
         * Force there to be a new era at the end of the next session. After this, it will be
         * reset to normal (non-forced) behaviour.
         *
         * The dispatch origin must be Root.
         *
         * # Warning
         *
         * The election process starts multiple blocks before the end of the era.
         * If this is called just before a new era is triggered, the election process may not
         * have enough blocks to get a result.
         *
         * ## Complexity
         * - No arguments.
         * - Weight: O(1)
         */
        force_new_era: TxDescriptor<undefined>;
        /**
         * Set the validators who cannot be slashed (if any).
         *
         * The dispatch origin must be Root.
         */
        set_invulnerables: TxDescriptor<Anonymize<I39t01nnod9109>>;
        /**
         * Force a current staker to become completely unstaked, immediately.
         *
         * The dispatch origin must be Root.
         *
         * ## Parameters
         *
         * - `num_slashing_spans`: Refer to comments on [`Call::withdraw_unbonded`] for more
         * details.
         */
        force_unstake: TxDescriptor<Anonymize<Ie5vbnd9198quk>>;
        /**
         * Force there to be a new era at the end of sessions indefinitely.
         *
         * The dispatch origin must be Root.
         *
         * # Warning
         *
         * The election process starts multiple blocks before the end of the era.
         * If this is called just before a new era is triggered, the election process may not
         * have enough blocks to get a result.
         */
        force_new_era_always: TxDescriptor<undefined>;
        /**
         * Cancel enactment of a deferred slash.
         *
         * Can be called by the `T::AdminOrigin`.
         *
         * Parameters: era and indices of the slashes for that era to kill.
         */
        cancel_deferred_slash: TxDescriptor<Anonymize<I3h6murn8bd4v5>>;
        /**
         * Pay out next page of the stakers behind a validator for the given era.
         *
         * - `validator_stash` is the stash account of the validator.
         * - `era` may be any era between `[current_era - history_depth; current_era]`.
         *
         * The origin of this call must be _Signed_. Any account can call this function, even if
         * it is not one of the stakers.
         *
         * The reward payout could be paged in case there are too many nominators backing the
         * `validator_stash`. This call will payout unpaid pages in an ascending order. To claim a
         * specific page, use `payout_stakers_by_page`.`
         *
         * If all pages are claimed, it returns an error `InvalidPage`.
         */
        payout_stakers: TxDescriptor<Anonymize<I6k6jf8ncesuu3>>;
        /**
         * Rebond a portion of the stash scheduled to be unlocked.
         *
         * The dispatch origin must be signed by the controller.
         *
         * ## Complexity
         * - Time complexity: O(L), where L is unlocking chunks
         * - Bounded by `MaxUnlockingChunks`.
         */
        rebond: TxDescriptor<Anonymize<Ie5v6njpckr05b>>;
        /**
         * Remove all data structures concerning a staker/stash once it is at a state where it can
         * be considered `dust` in the staking system. The requirements are:
         *
         * 1. the `total_balance` of the stash is below existential deposit.
         * 2. or, the `ledger.total` of the stash is below existential deposit.
         * 3. or, existential deposit is zero and either `total_balance` or `ledger.total` is zero.
         *
         * The former can happen in cases like a slash; the latter when a fully unbonded account
         * is still receiving staking rewards in `RewardDestination::Staked`.
         *
         * It can be called by anyone, as long as `stash` meets the above requirements.
         *
         * Refunds the transaction fees upon successful execution.
         *
         * ## Parameters
         *
         * - `num_slashing_spans`: Refer to comments on [`Call::withdraw_unbonded`] for more
         * details.
         */
        reap_stash: TxDescriptor<Anonymize<Ie5vbnd9198quk>>;
        /**
         * Remove the given nominations from the calling validator.
         *
         * Effects will be felt at the beginning of the next era.
         *
         * The dispatch origin for this call must be _Signed_ by the controller, not the stash.
         *
         * - `who`: A list of nominator stash accounts who are nominating this validator which
         * should no longer be nominating this validator.
         *
         * Note: Making this call only makes sense if you first set the validator preferences to
         * block any further nominations.
         */
        kick: TxDescriptor<Anonymize<I6rqcpg80db1fb>>;
        /**
         * Update the various staking configurations .
         *
         * * `min_nominator_bond`: The minimum active bond needed to be a nominator.
         * * `min_validator_bond`: The minimum active bond needed to be a validator.
         * * `max_nominator_count`: The max number of users who can be a nominator at once. When
         * set to `None`, no limit is enforced.
         * * `max_validator_count`: The max number of users who can be a validator at once. When
         * set to `None`, no limit is enforced.
         * * `chill_threshold`: The ratio of `max_nominator_count` or `max_validator_count` which
         * should be filled in order for the `chill_other` transaction to work.
         * * `min_commission`: The minimum amount of commission that each validators must maintain.
         * This is checked only upon calling `validate`. Existing validators are not affected.
         *
         * RuntimeOrigin must be Root to call this function.
         *
         * NOTE: Existing nominators and validators will not be affected by this update.
         * to kick people under the new limits, `chill_other` should be called.
         */
        set_staking_configs: TxDescriptor<Anonymize<If1qr0kbbl298c>>;
        /**
         * Declare a `controller` to stop participating as either a validator or nominator.
         *
         * Effects will be felt at the beginning of the next era.
         *
         * The dispatch origin for this call must be _Signed_, but can be called by anyone.
         *
         * If the caller is the same as the controller being targeted, then no further checks are
         * enforced, and this function behaves just like `chill`.
         *
         * If the caller is different than the controller being targeted, the following conditions
         * must be met:
         *
         * * `controller` must belong to a nominator who has become non-decodable,
         *
         * Or:
         *
         * * A `ChillThreshold` must be set and checked which defines how close to the max
         * nominators or validators we must reach before users can start chilling one-another.
         * * A `MaxNominatorCount` and `MaxValidatorCount` must be set which is used to determine
         * how close we are to the threshold.
         * * A `MinNominatorBond` and `MinValidatorBond` must be set and checked, which determines
         * if this is a person that should be chilled because they have not met the threshold
         * bond required.
         *
         * This can be helpful if bond requirements are updated, and we need to remove old users
         * who do not satisfy these requirements.
         */
        chill_other: TxDescriptor<Anonymize<Idl3umm12u5pa>>;
        /**
         * Force a validator to have at least the minimum commission. This will not affect a
         * validator who already has a commission greater than or equal to the minimum. Any account
         * can call this.
         */
        force_apply_min_commission: TxDescriptor<Anonymize<I5ont0141q9ss5>>;
        /**
         * Sets the minimum amount of commission that each validators must maintain.
         *
         * This call has lower privilege requirements than `set_staking_config` and can be called
         * by the `T::AdminOrigin`. Root can always call this.
         */
        set_min_commission: TxDescriptor<Anonymize<I3vh014cqgmrfd>>;
        /**
         * Pay out a page of the stakers behind a validator for the given era and page.
         *
         * - `validator_stash` is the stash account of the validator.
         * - `era` may be any era between `[current_era - history_depth; current_era]`.
         * - `page` is the page index of nominators to pay out with value between 0 and
         * `num_nominators / T::MaxExposurePageSize`.
         *
         * The origin of this call must be _Signed_. Any account can call this function, even if
         * it is not one of the stakers.
         *
         * If a validator has more than [`Config::MaxExposurePageSize`] nominators backing
         * them, then the list of nominators is paged, with each page being capped at
         * [`Config::MaxExposurePageSize`.] If a validator has more than one page of nominators,
         * the call needs to be made for each page separately in order for all the nominators
         * backing a validator to receive the reward. The nominators are not sorted across pages
         * and so it should not be assumed the highest staker would be on the topmost page and vice
         * versa. If rewards are not claimed in [`Config::HistoryDepth`] eras, they are lost.
         */
        payout_stakers_by_page: TxDescriptor<Anonymize<Ie6j49utvii126>>;
        /**
         * Migrates an account's `RewardDestination::Controller` to
         * `RewardDestination::Account(controller)`.
         *
         * Effects will be felt instantly (as soon as this function is completed successfully).
         *
         * This will waive the transaction fee if the `payee` is successfully migrated.
         */
        update_payee: TxDescriptor<Anonymize<I3v6ks33uluhnj>>;
        /**
         * Updates a batch of controller accounts to their corresponding stash account if they are
         * not the same. Ignores any controller accounts that do not exist, and does not operate if
         * the stash and controller are already the same.
         *
         * Effects will be felt instantly (as soon as this function is completed successfully).
         *
         * The dispatch origin must be `T::AdminOrigin`.
         */
        deprecate_controller_batch: TxDescriptor<Anonymize<I3kiiim1cds68i>>;
        /**
         * Restores the state of a ledger which is in an inconsistent state.
         *
         * The requirements to restore a ledger are the following:
         * * The stash is bonded; or
         * * The stash is not bonded but it has a staking lock left behind; or
         * * If the stash has an associated ledger and its state is inconsistent; or
         * * If the ledger is not corrupted *but* its staking lock is out of sync.
         *
         * The `maybe_*` input parameters will overwrite the corresponding data and metadata of the
         * ledger associated with the stash. If the input parameters are not set, the ledger will
         * be reset values from on-chain state.
         */
        restore_ledger: TxDescriptor<Anonymize<I4k60mkh2r6jjg>>;
    };
    Session: {
        /**
         * Sets the session key(s) of the function caller to `keys`.
         * Allows an account to set its session key prior to becoming a validator.
         * This doesn't take effect until the next session.
         *
         * The dispatch origin of this function must be signed.
         *
         * ## Complexity
         * - `O(1)`. Actual cost depends on the number of length of `T::Keys::key_ids()` which is
         * fixed.
         */
        set_keys: TxDescriptor<Anonymize<I7b38nnt67hfdg>>;
        /**
         * Removes any session key(s) of the function caller.
         *
         * This doesn't take effect until the next session.
         *
         * The dispatch origin of this function must be Signed and the account must be either be
         * convertible to a validator ID using the chain's typical addressing system (this usually
         * means being a controller account) or directly convertible into a validator ID (which
         * usually means being a stash account).
         *
         * ## Complexity
         * - `O(1)` in number of key types. Actual cost depends on the number of length of
         * `T::Keys::key_ids()` which is fixed.
         */
        purge_keys: TxDescriptor<undefined>;
    };
    Treasury: {
        /**
         * Propose and approve a spend of treasury funds.
         *
         * ## Dispatch Origin
         *
         * Must be [`Config::SpendOrigin`] with the `Success` value being at least `amount`.
         *
         * ### Details
         * NOTE: For record-keeping purposes, the proposer is deemed to be equivalent to the
         * beneficiary.
         *
         * ### Parameters
         * - `amount`: The amount to be transferred from the treasury to the `beneficiary`.
         * - `beneficiary`: The destination account for the transfer.
         *
         * ## Events
         *
         * Emits [`Event::SpendApproved`] if successful.
         */
        spend_local: TxDescriptor<Anonymize<I7fcl4aua07ato>>;
        /**
         * Force a previously approved proposal to be removed from the approval queue.
         *
         * ## Dispatch Origin
         *
         * Must be [`Config::RejectOrigin`].
         *
         * ## Details
         *
         * The original deposit will no longer be returned.
         *
         * ### Parameters
         * - `proposal_id`: The index of a proposal
         *
         * ### Complexity
         * - O(A) where `A` is the number of approvals
         *
         * ### Errors
         * - [`Error::ProposalNotApproved`]: The `proposal_id` supplied was not found in the
         * approval queue, i.e., the proposal has not been approved. This could also mean the
         * proposal does not exist altogether, thus there is no way it would have been approved
         * in the first place.
         */
        remove_approval: TxDescriptor<Anonymize<Icm9m0qeemu66d>>;
        /**
         * Propose and approve a spend of treasury funds.
         *
         * ## Dispatch Origin
         *
         * Must be [`Config::SpendOrigin`] with the `Success` value being at least
         * `amount` of `asset_kind` in the native asset. The amount of `asset_kind` is converted
         * for assertion using the [`Config::BalanceConverter`].
         *
         * ## Details
         *
         * Create an approved spend for transferring a specific `amount` of `asset_kind` to a
         * designated beneficiary. The spend must be claimed using the `payout` dispatchable within
         * the [`Config::PayoutPeriod`].
         *
         * ### Parameters
         * - `asset_kind`: An indicator of the specific asset class to be spent.
         * - `amount`: The amount to be transferred from the treasury to the `beneficiary`.
         * - `beneficiary`: The beneficiary of the spend.
         * - `valid_from`: The block number from which the spend can be claimed. It can refer to
         * the past if the resulting spend has not yet expired according to the
         * [`Config::PayoutPeriod`]. If `None`, the spend can be claimed immediately after
         * approval.
         *
         * ## Events
         *
         * Emits [`Event::AssetSpendApproved`] if successful.
         */
        spend: TxDescriptor<Anonymize<Iff30ongi0pbsu>>;
        /**
         * Claim a spend.
         *
         * ## Dispatch Origin
         *
         * Must be signed
         *
         * ## Details
         *
         * Spends must be claimed within some temporal bounds. A spend may be claimed within one
         * [`Config::PayoutPeriod`] from the `valid_from` block.
         * In case of a payout failure, the spend status must be updated with the `check_status`
         * dispatchable before retrying with the current function.
         *
         * ### Parameters
         * - `index`: The spend index.
         *
         * ## Events
         *
         * Emits [`Event::Paid`] if successful.
         */
        payout: TxDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * Check the status of the spend and remove it from the storage if processed.
         *
         * ## Dispatch Origin
         *
         * Must be signed.
         *
         * ## Details
         *
         * The status check is a prerequisite for retrying a failed payout.
         * If a spend has either succeeded or expired, it is removed from the storage by this
         * function. In such instances, transaction fees are refunded.
         *
         * ### Parameters
         * - `index`: The spend index.
         *
         * ## Events
         *
         * Emits [`Event::PaymentFailed`] if the spend payout has failed.
         * Emits [`Event::SpendProcessed`] if the spend payout has succeed.
         */
        check_status: TxDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * Void previously approved spend.
         *
         * ## Dispatch Origin
         *
         * Must be [`Config::RejectOrigin`].
         *
         * ## Details
         *
         * A spend void is only possible if the payout has not been attempted yet.
         *
         * ### Parameters
         * - `index`: The spend index.
         *
         * ## Events
         *
         * Emits [`Event::AssetSpendVoided`] if successful.
         */
        void_spend: TxDescriptor<Anonymize<I666bl2fqjkejo>>;
    };
    Bounties: {
        /**
         * Propose a new bounty.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * Payment: `TipReportDepositBase` will be reserved from the origin account, as well as
         * `DataDepositPerByte` for each byte in `reason`. It will be unreserved upon approval,
         * or slashed when rejected.
         *
         * - `curator`: The curator account whom will manage this bounty.
         * - `fee`: The curator fee.
         * - `value`: The total payment amount of this bounty, curator fee included.
         * - `description`: The description of this bounty.
         */
        propose_bounty: TxDescriptor<Anonymize<I2a839vbf5817q>>;
        /**
         * Approve a bounty proposal. At a later time, the bounty will be funded and become active
         * and the original deposit will be returned.
         *
         * May only be called from `T::SpendOrigin`.
         *
         * ## Complexity
         * - O(1).
         */
        approve_bounty: TxDescriptor<Anonymize<Ia9p5bg6p18r0i>>;
        /**
         * Propose a curator to a funded bounty.
         *
         * May only be called from `T::SpendOrigin`.
         *
         * ## Complexity
         * - O(1).
         */
        propose_curator: TxDescriptor<Anonymize<I5rlb1eesbovji>>;
        /**
         * Unassign curator from a bounty.
         *
         * This function can only be called by the `RejectOrigin` a signed origin.
         *
         * If this function is called by the `RejectOrigin`, we assume that the curator is
         * malicious or inactive. As a result, we will slash the curator when possible.
         *
         * If the origin is the curator, we take this as a sign they are unable to do their job and
         * they willingly give up. We could slash them, but for now we allow them to recover their
         * deposit and exit without issue. (We may want to change this if it is abused.)
         *
         * Finally, the origin can be anyone if and only if the curator is "inactive". This allows
         * anyone in the community to call out that a curator is not doing their due diligence, and
         * we should pick a new curator. In this case the curator should also be slashed.
         *
         * ## Complexity
         * - O(1).
         */
        unassign_curator: TxDescriptor<Anonymize<Ia9p5bg6p18r0i>>;
        /**
         * Accept the curator role for a bounty.
         * A deposit will be reserved from curator and refund upon successful payout.
         *
         * May only be called from the curator.
         *
         * ## Complexity
         * - O(1).
         */
        accept_curator: TxDescriptor<Anonymize<Ia9p5bg6p18r0i>>;
        /**
         * Award bounty to a beneficiary account. The beneficiary will be able to claim the funds
         * after a delay.
         *
         * The dispatch origin for this call must be the curator of this bounty.
         *
         * - `bounty_id`: Bounty ID to award.
         * - `beneficiary`: The beneficiary account whom will receive the payout.
         *
         * ## Complexity
         * - O(1).
         */
        award_bounty: TxDescriptor<Anonymize<Ia96ru6pujbas0>>;
        /**
         * Claim the payout from an awarded bounty after payout delay.
         *
         * The dispatch origin for this call must be the beneficiary of this bounty.
         *
         * - `bounty_id`: Bounty ID to claim.
         *
         * ## Complexity
         * - O(1).
         */
        claim_bounty: TxDescriptor<Anonymize<Ia9p5bg6p18r0i>>;
        /**
         * Cancel a proposed or active bounty. All the funds will be sent to treasury and
         * the curator deposit will be unreserved if possible.
         *
         * Only `T::RejectOrigin` is able to cancel a bounty.
         *
         * - `bounty_id`: Bounty ID to cancel.
         *
         * ## Complexity
         * - O(1).
         */
        close_bounty: TxDescriptor<Anonymize<Ia9p5bg6p18r0i>>;
        /**
         * Extend the expiry time of an active bounty.
         *
         * The dispatch origin for this call must be the curator of this bounty.
         *
         * - `bounty_id`: Bounty ID to extend.
         * - `remark`: additional information.
         *
         * ## Complexity
         * - O(1).
         */
        extend_bounty_expiry: TxDescriptor<Anonymize<I90n6nnkpdahrh>>;
    };
    ChildBounties: {
        /**
         * Add a new child-bounty.
         *
         * The dispatch origin for this call must be the curator of parent
         * bounty and the parent bounty must be in "active" state.
         *
         * Child-bounty gets added successfully & fund gets transferred from
         * parent bounty to child-bounty account, if parent bounty has enough
         * funds, else the call fails.
         *
         * Upper bound to maximum number of active  child bounties that can be
         * added are managed via runtime trait config
         * [`Config::MaxActiveChildBountyCount`].
         *
         * If the call is success, the status of child-bounty is updated to
         * "Added".
         *
         * - `parent_bounty_id`: Index of parent bounty for which child-bounty is being added.
         * - `value`: Value for executing the proposal.
         * - `description`: Text description for the child-bounty.
         */
        add_child_bounty: TxDescriptor<Anonymize<I8mk5kjgn02hi8>>;
        /**
         * Propose curator for funded child-bounty.
         *
         * The dispatch origin for this call must be curator of parent bounty.
         *
         * Parent bounty must be in active state, for this child-bounty call to
         * work.
         *
         * Child-bounty must be in "Added" state, for processing the call. And
         * state of child-bounty is moved to "CuratorProposed" on successful
         * call completion.
         *
         * - `parent_bounty_id`: Index of parent bounty.
         * - `child_bounty_id`: Index of child bounty.
         * - `curator`: Address of child-bounty curator.
         * - `fee`: payment fee to child-bounty curator for execution.
         */
        propose_curator: TxDescriptor<Anonymize<I5onpf3u0obsqb>>;
        /**
         * Accept the curator role for the child-bounty.
         *
         * The dispatch origin for this call must be the curator of this
         * child-bounty.
         *
         * A deposit will be reserved from the curator and refund upon
         * successful payout or cancellation.
         *
         * Fee for curator is deducted from curator fee of parent bounty.
         *
         * Parent bounty must be in active state, for this child-bounty call to
         * work.
         *
         * Child-bounty must be in "CuratorProposed" state, for processing the
         * call. And state of child-bounty is moved to "Active" on successful
         * call completion.
         *
         * - `parent_bounty_id`: Index of parent bounty.
         * - `child_bounty_id`: Index of child bounty.
         */
        accept_curator: TxDescriptor<Anonymize<I2gr10p66od9ch>>;
        /**
         * Unassign curator from a child-bounty.
         *
         * The dispatch origin for this call can be either `RejectOrigin`, or
         * the curator of the parent bounty, or any signed origin.
         *
         * For the origin other than T::RejectOrigin and the child-bounty
         * curator, parent bounty must be in active state, for this call to
         * work. We allow child-bounty curator and T::RejectOrigin to execute
         * this call irrespective of the parent bounty state.
         *
         * If this function is called by the `RejectOrigin` or the
         * parent bounty curator, we assume that the child-bounty curator is
         * malicious or inactive. As a result, child-bounty curator deposit is
         * slashed.
         *
         * If the origin is the child-bounty curator, we take this as a sign
         * that they are unable to do their job, and are willingly giving up.
         * We could slash the deposit, but for now we allow them to unreserve
         * their deposit and exit without issue. (We may want to change this if
         * it is abused.)
         *
         * Finally, the origin can be anyone iff the child-bounty curator is
         * "inactive". Expiry update due of parent bounty is used to estimate
         * inactive state of child-bounty curator.
         *
         * This allows anyone in the community to call out that a child-bounty
         * curator is not doing their due diligence, and we should pick a new
         * one. In this case the child-bounty curator deposit is slashed.
         *
         * State of child-bounty is moved to Added state on successful call
         * completion.
         *
         * - `parent_bounty_id`: Index of parent bounty.
         * - `child_bounty_id`: Index of child bounty.
         */
        unassign_curator: TxDescriptor<Anonymize<I2gr10p66od9ch>>;
        /**
         * Award child-bounty to a beneficiary.
         *
         * The beneficiary will be able to claim the funds after a delay.
         *
         * The dispatch origin for this call must be the parent curator or
         * curator of this child-bounty.
         *
         * Parent bounty must be in active state, for this child-bounty call to
         * work.
         *
         * Child-bounty must be in active state, for processing the call. And
         * state of child-bounty is moved to "PendingPayout" on successful call
         * completion.
         *
         * - `parent_bounty_id`: Index of parent bounty.
         * - `child_bounty_id`: Index of child bounty.
         * - `beneficiary`: Beneficiary account.
         */
        award_child_bounty: TxDescriptor<Anonymize<I5d9an59q96b9e>>;
        /**
         * Claim the payout from an awarded child-bounty after payout delay.
         *
         * The dispatch origin for this call may be any signed origin.
         *
         * Call works independent of parent bounty state, No need for parent
         * bounty to be in active state.
         *
         * The Beneficiary is paid out with agreed bounty value. Curator fee is
         * paid & curator deposit is unreserved.
         *
         * Child-bounty must be in "PendingPayout" state, for processing the
         * call. And instance of child-bounty is removed from the state on
         * successful call completion.
         *
         * - `parent_bounty_id`: Index of parent bounty.
         * - `child_bounty_id`: Index of child bounty.
         */
        claim_child_bounty: TxDescriptor<Anonymize<I2gr10p66od9ch>>;
        /**
         * Cancel a proposed or active child-bounty. Child-bounty account funds
         * are transferred to parent bounty account. The child-bounty curator
         * deposit may be unreserved if possible.
         *
         * The dispatch origin for this call must be either parent curator or
         * `T::RejectOrigin`.
         *
         * If the state of child-bounty is `Active`, curator deposit is
         * unreserved.
         *
         * If the state of child-bounty is `PendingPayout`, call fails &
         * returns `PendingPayout` error.
         *
         * For the origin other than T::RejectOrigin, parent bounty must be in
         * active state, for this child-bounty call to work. For origin
         * T::RejectOrigin execution is forced.
         *
         * Instance of child-bounty is removed from the state on successful
         * call completion.
         *
         * - `parent_bounty_id`: Index of parent bounty.
         * - `child_bounty_id`: Index of child bounty.
         */
        close_child_bounty: TxDescriptor<Anonymize<I2gr10p66od9ch>>;
    };
    BagsList: {
        /**
         * Declare that some `dislocated` account has, through rewards or penalties, sufficiently
         * changed its score that it should properly fall into a different bag than its current
         * one.
         *
         * Anyone can call this function about any potentially dislocated account.
         *
         * Will always update the stored score of `dislocated` to the correct score, based on
         * `ScoreProvider`.
         *
         * If `dislocated` does not exists, it returns an error.
         */
        rebag: TxDescriptor<Anonymize<Iepvl96j3rpblo>>;
        /**
         * Move the caller's Id directly in front of `lighter`.
         *
         * The dispatch origin for this call must be _Signed_ and can only be called by the Id of
         * the account going in front of `lighter`. Fee is payed by the origin under all
         * circumstances.
         *
         * Only works if:
         *
         * - both nodes are within the same bag,
         * - and `origin` has a greater `Score` than `lighter`.
         */
        put_in_front_of: TxDescriptor<Anonymize<Iems2cb8v3lka8>>;
        /**
         * Same as [`Pallet::put_in_front_of`], but it can be called by anyone.
         *
         * Fee is paid by the origin under all circumstances.
         */
        put_in_front_of_other: TxDescriptor<Anonymize<I4oh0ds0hgt386>>;
    };
    NominationPools: {
        /**
         * Stake funds with a pool. The amount to bond is transferred from the member to the
         * pools account and immediately increases the pools bond.
         *
         * # Note
         *
         * * An account can only be a member of a single pool.
         * * An account cannot join the same pool multiple times.
         * * This call will *not* dust the member account, so the member must have at least
         * `existential deposit + amount` in their account.
         * * Only a pool with [`PoolState::Open`] can be joined
         */
        join: TxDescriptor<Anonymize<Ieg1oc56mamrl5>>;
        /**
         * Bond `extra` more funds from `origin` into the pool to which they already belong.
         *
         * Additional funds can come from either the free balance of the account, of from the
         * accumulated rewards, see [`BondExtra`].
         *
         * Bonding extra funds implies an automatic payout of all pending rewards as well.
         * See `bond_extra_other` to bond pending rewards of `other` members.
         */
        bond_extra: TxDescriptor<Anonymize<I2vu5vj7173ik9>>;
        /**
         * A bonded member can use this to claim their payout based on the rewards that the pool
         * has accumulated since their last claimed payout (OR since joining if this is their first
         * time claiming rewards). The payout will be transferred to the member's account.
         *
         * The member will earn rewards pro rata based on the members stake vs the sum of the
         * members in the pools stake. Rewards do not "expire".
         *
         * See `claim_payout_other` to claim rewards on behalf of some `other` pool member.
         */
        claim_payout: TxDescriptor<undefined>;
        /**
         * Unbond up to `unbonding_points` of the `member_account`'s funds from the pool. It
         * implicitly collects the rewards one last time, since not doing so would mean some
         * rewards would be forfeited.
         *
         * Under certain conditions, this call can be dispatched permissionlessly (i.e. by any
         * account).
         *
         * # Conditions for a permissionless dispatch.
         *
         * * The pool is blocked and the caller is either the root or bouncer. This is refereed to
         * as a kick.
         * * The pool is destroying and the member is not the depositor.
         * * The pool is destroying, the member is the depositor and no other members are in the
         * pool.
         *
         * ## Conditions for permissioned dispatch (i.e. the caller is also the
         * `member_account`):
         *
         * * The caller is not the depositor.
         * * The caller is the depositor, the pool is destroying and no other members are in the
         * pool.
         *
         * # Note
         *
         * If there are too many unlocking chunks to unbond with the pool account,
         * [`Call::pool_withdraw_unbonded`] can be called to try and minimize unlocking chunks.
         * The [`StakingInterface::unbond`] will implicitly call [`Call::pool_withdraw_unbonded`]
         * to try to free chunks if necessary (ie. if unbound was called and no unlocking chunks
         * are available). However, it may not be possible to release the current unlocking chunks,
         * in which case, the result of this call will likely be the `NoMoreChunks` error from the
         * staking system.
         */
        unbond: TxDescriptor<Anonymize<Id70c5vciftf2i>>;
        /**
         * Call `withdraw_unbonded` for the pools account. This call can be made by any account.
         *
         * This is useful if there are too many unlocking chunks to call `unbond`, and some
         * can be cleared by withdrawing. In the case there are too many unlocking chunks, the user
         * would probably see an error like `NoMoreChunks` emitted from the staking system when
         * they attempt to unbond.
         */
        pool_withdraw_unbonded: TxDescriptor<Anonymize<I36uoc8t9liv80>>;
        /**
         * Withdraw unbonded funds from `member_account`. If no bonded funds can be unbonded, an
         * error is returned.
         *
         * Under certain conditions, this call can be dispatched permissionlessly (i.e. by any
         * account).
         *
         * # Conditions for a permissionless dispatch
         *
         * * The pool is in destroy mode and the target is not the depositor.
         * * The target is the depositor and they are the only member in the sub pools.
         * * The pool is blocked and the caller is either the root or bouncer.
         *
         * # Conditions for permissioned dispatch
         *
         * * The caller is the target and they are not the depositor.
         *
         * # Note
         *
         * - If the target is the depositor, the pool will be destroyed.
         * - If the pool has any pending slash, we also try to slash the member before letting them
         * withdraw. This calculation adds some weight overhead and is only defensive. In reality,
         * pool slashes must have been already applied via permissionless [`Call::apply_slash`].
         */
        withdraw_unbonded: TxDescriptor<Anonymize<I9iq45aekjq7kb>>;
        /**
         * Create a new delegation pool.
         *
         * # Arguments
         *
         * * `amount` - The amount of funds to delegate to the pool. This also acts of a sort of
         * deposit since the pools creator cannot fully unbond funds until the pool is being
         * destroyed.
         * * `index` - A disambiguation index for creating the account. Likely only useful when
         * creating multiple pools in the same extrinsic.
         * * `root` - The account to set as [`PoolRoles::root`].
         * * `nominator` - The account to set as the [`PoolRoles::nominator`].
         * * `bouncer` - The account to set as the [`PoolRoles::bouncer`].
         *
         * # Note
         *
         * In addition to `amount`, the caller will transfer the existential deposit; so the caller
         * needs at have at least `amount + existential_deposit` transferable.
         */
        create: TxDescriptor<Anonymize<I26ne2mpnrbqa5>>;
        /**
         * Create a new delegation pool with a previously used pool id
         *
         * # Arguments
         *
         * same as `create` with the inclusion of
         * * `pool_id` - `A valid PoolId.
         */
        create_with_pool_id: TxDescriptor<Anonymize<I9tlpr80ot76ta>>;
        /**
         * Nominate on behalf of the pool.
         *
         * The dispatch origin of this call must be signed by the pool nominator or the pool
         * root role.
         *
         * This directly forward the call to the staking pallet, on behalf of the pool bonded
         * account.
         *
         * # Note
         *
         * In addition to a `root` or `nominator` role of `origin`, pool's depositor needs to have
         * at least `depositor_min_bond` in the pool to start nominating.
         */
        nominate: TxDescriptor<Anonymize<I47a2tsd2o2b1c>>;
        /**
         * Set a new state for the pool.
         *
         * If a pool is already in the `Destroying` state, then under no condition can its state
         * change again.
         *
         * The dispatch origin of this call must be either:
         *
         * 1. signed by the bouncer, or the root role of the pool,
         * 2. if the pool conditions to be open are NOT met (as described by `ok_to_be_open`), and
         * then the state of the pool can be permissionlessly changed to `Destroying`.
         */
        set_state: TxDescriptor<Anonymize<Ifc9k1s0e9nv8e>>;
        /**
         * Set a new metadata for the pool.
         *
         * The dispatch origin of this call must be signed by the bouncer, or the root role of the
         * pool.
         */
        set_metadata: TxDescriptor<Anonymize<I4ihj26hl75e5p>>;
        /**
         * Update configurations for the nomination pools. The origin for this call must be
         * [`Config::AdminOrigin`].
         *
         * # Arguments
         *
         * * `min_join_bond` - Set [`MinJoinBond`].
         * * `min_create_bond` - Set [`MinCreateBond`].
         * * `max_pools` - Set [`MaxPools`].
         * * `max_members` - Set [`MaxPoolMembers`].
         * * `max_members_per_pool` - Set [`MaxPoolMembersPerPool`].
         * * `global_max_commission` - Set [`GlobalMaxCommission`].
         */
        set_configs: TxDescriptor<Anonymize<I2dl8ekhm2t22h>>;
        /**
         * Update the roles of the pool.
         *
         * The root is the only entity that can change any of the roles, including itself,
         * excluding the depositor, who can never change.
         *
         * It emits an event, notifying UIs of the role change. This event is quite relevant to
         * most pool members and they should be informed of changes to pool roles.
         */
        update_roles: TxDescriptor<Anonymize<I13us5e5h5645o>>;
        /**
         * Chill on behalf of the pool.
         *
         * The dispatch origin of this call can be signed by the pool nominator or the pool
         * root role, same as [`Pallet::nominate`].
         *
         * Under certain conditions, this call can be dispatched permissionlessly (i.e. by any
         * account).
         *
         * # Conditions for a permissionless dispatch:
         * * When pool depositor has less than `MinNominatorBond` staked, otherwise  pool members
         * are unable to unbond.
         *
         * # Conditions for permissioned dispatch:
         * * The caller has a nominator or root role of the pool.
         * This directly forward the call to the staking pallet, on behalf of the pool bonded
         * account.
         */
        chill: TxDescriptor<Anonymize<I931cottvong90>>;
        /**
         * `origin` bonds funds from `extra` for some pool member `member` into their respective
         * pools.
         *
         * `origin` can bond extra funds from free balance or pending rewards when `origin ==
         * other`.
         *
         * In the case of `origin != other`, `origin` can only bond extra pending rewards of
         * `other` members assuming set_claim_permission for the given member is
         * `PermissionlessCompound` or `PermissionlessAll`.
         */
        bond_extra_other: TxDescriptor<Anonymize<Ic4h0nvtu79ch6>>;
        /**
         * Allows a pool member to set a claim permission to allow or disallow permissionless
         * bonding and withdrawing.
         *
         * # Arguments
         *
         * * `origin` - Member of a pool.
         * * `permission` - The permission to be applied.
         */
        set_claim_permission: TxDescriptor<Anonymize<I1ors0vru14it3>>;
        /**
         * `origin` can claim payouts on some pool member `other`'s behalf.
         *
         * Pool member `other` must have a `PermissionlessWithdraw` or `PermissionlessAll` claim
         * permission for this call to be successful.
         */
        claim_payout_other: TxDescriptor<Anonymize<I40s11r8nagn2g>>;
        /**
         * Set the commission of a pool.
         * Both a commission percentage and a commission payee must be provided in the `current`
         * tuple. Where a `current` of `None` is provided, any current commission will be removed.
         *
         * - If a `None` is supplied to `new_commission`, existing commission will be removed.
         */
        set_commission: TxDescriptor<Anonymize<I6bjj87fr5g9nl>>;
        /**
         * Set the maximum commission of a pool.
         *
         * - Initial max can be set to any `Perbill`, and only smaller values thereafter.
         * - Current commission will be lowered in the event it is higher than a new max
         * commission.
         */
        set_commission_max: TxDescriptor<Anonymize<I8cbluptqo8kbp>>;
        /**
         * Set the commission change rate for a pool.
         *
         * Initial change rate is not bounded, whereas subsequent updates can only be more
         * restrictive than the current.
         */
        set_commission_change_rate: TxDescriptor<Anonymize<I6t5r359eagicn>>;
        /**
         * Claim pending commission.
         *
         * The dispatch origin of this call must be signed by the `root` role of the pool. Pending
         * commission is paid out and added to total claimed commission`. Total pending commission
         * is reset to zero. the current.
         */
        claim_commission: TxDescriptor<Anonymize<I931cottvong90>>;
        /**
         * Top up the deficit or withdraw the excess ED from the pool.
         *
         * When a pool is created, the pool depositor transfers ED to the reward account of the
         * pool. ED is subject to change and over time, the deposit in the reward account may be
         * insufficient to cover the ED deficit of the pool or vice-versa where there is excess
         * deposit to the pool. This call allows anyone to adjust the ED deposit of the
         * pool by either topping up the deficit or claiming the excess.
         */
        adjust_pool_deposit: TxDescriptor<Anonymize<I931cottvong90>>;
        /**
         * Set or remove a pool's commission claim permission.
         *
         * Determines who can claim the pool's pending commission. Only the `Root` role of the pool
         * is able to configure commission claim permissions.
         */
        set_commission_claim_permission: TxDescriptor<Anonymize<I3ihan8icf0c5k>>;
        /**
         * Apply a pending slash on a member.
         *
         * Fails unless [`crate::pallet::Config::StakeAdapter`] is of strategy type:
         * [`adapter::StakeStrategyType::Delegate`].
         *
         * The pending slash amount of the member must be equal or more than `ExistentialDeposit`.
         * This call can be dispatched permissionlessly (i.e. by any account). If the execution
         * is successful, fee is refunded and caller may be rewarded with a part of the slash
         * based on the [`crate::pallet::Config::StakeAdapter`] configuration.
         */
        apply_slash: TxDescriptor<Anonymize<I7aouqn0g9m7gc>>;
        /**
         * Migrates delegated funds from the pool account to the `member_account`.
         *
         * Fails unless [`crate::pallet::Config::StakeAdapter`] is of strategy type:
         * [`adapter::StakeStrategyType::Delegate`].
         *
         * This is a permission-less call and refunds any fee if claim is successful.
         *
         * If the pool has migrated to delegation based staking, the staked tokens of pool members
         * can be moved and held in their own account. See [`adapter::DelegateStake`]
         */
        migrate_delegation: TxDescriptor<Anonymize<I7aouqn0g9m7gc>>;
        /**
         * Migrate pool from [`adapter::StakeStrategyType::Transfer`] to
         * [`adapter::StakeStrategyType::Delegate`].
         *
         * Fails unless [`crate::pallet::Config::StakeAdapter`] is of strategy type:
         * [`adapter::StakeStrategyType::Delegate`].
         *
         * This call can be dispatched permissionlessly, and refunds any fee if successful.
         *
         * If the pool has already migrated to delegation based staking, this call will fail.
         */
        migrate_pool_to_delegate_stake: TxDescriptor<Anonymize<I931cottvong90>>;
    };
    Scheduler: {
        /**
         * Anonymously schedule a task.
         */
        schedule: TxDescriptor<Anonymize<I8e7g876q3bfql>>;
        /**
         * Cancel an anonymously scheduled task.
         */
        cancel: TxDescriptor<Anonymize<I229jvdlbdhm94>>;
        /**
         * Schedule a named task.
         */
        schedule_named: TxDescriptor<Anonymize<I9dm0i7fm6o3ac>>;
        /**
         * Cancel a named scheduled task.
         */
        cancel_named: TxDescriptor<Anonymize<Ifs1i5fk9cqvr6>>;
        /**
         * Anonymously schedule a task after a delay.
         */
        schedule_after: TxDescriptor<Anonymize<I8687goclso3lb>>;
        /**
         * Schedule a named task after a delay.
         */
        schedule_named_after: TxDescriptor<Anonymize<Ids6rugsrrgf4d>>;
        /**
         * Set a retry configuration for a task so that, in case its scheduled run fails, it will
         * be retried after `period` blocks, for a total amount of `retries` retries or until it
         * succeeds.
         *
         * Tasks which need to be scheduled for a retry are still subject to weight metering and
         * agenda space, same as a regular task. If a periodic task fails, it will be scheduled
         * normally while the task is retrying.
         *
         * Tasks scheduled as a result of a retry for a periodic task are unnamed, non-periodic
         * clones of the original task. Their retry configuration will be derived from the
         * original task's configuration, but will have a lower value for `remaining` than the
         * original `total_retries`.
         */
        set_retry: TxDescriptor<Anonymize<Iihueknplcvov>>;
        /**
         * Set a retry configuration for a named task so that, in case its scheduled run fails, it
         * will be retried after `period` blocks, for a total amount of `retries` retries or until
         * it succeeds.
         *
         * Tasks which need to be scheduled for a retry are still subject to weight metering and
         * agenda space, same as a regular task. If a periodic task fails, it will be scheduled
         * normally while the task is retrying.
         *
         * Tasks scheduled as a result of a retry for a periodic task are unnamed, non-periodic
         * clones of the original task. Their retry configuration will be derived from the
         * original task's configuration, but will have a lower value for `remaining` than the
         * original `total_retries`.
         */
        set_retry_named: TxDescriptor<Anonymize<Ifujo84eluf6dm>>;
        /**
         * Removes the retry configuration of a task.
         */
        cancel_retry: TxDescriptor<Anonymize<I1d9656ogitc3u>>;
        /**
         * Cancel the retry configuration of a named task.
         */
        cancel_retry_named: TxDescriptor<Anonymize<Ifs1i5fk9cqvr6>>;
    };
    Preimage: {
        /**
         * Register a preimage on-chain.
         *
         * If the preimage was previously requested, no fees or deposits are taken for providing
         * the preimage. Otherwise, a deposit is taken proportional to the size of the preimage.
         */
        note_preimage: TxDescriptor<Anonymize<I82nfqfkd48n10>>;
        /**
         * Clear an unrequested preimage from the runtime storage.
         *
         * If `len` is provided, then it will be a much cheaper operation.
         *
         * - `hash`: The hash of the preimage to be removed from the store.
         * - `len`: The length of the preimage of `hash`.
         */
        unnote_preimage: TxDescriptor<Anonymize<I1jm8m1rh9e20v>>;
        /**
         * Request a preimage be uploaded to the chain without paying any fees or deposits.
         *
         * If the preimage requests has already been provided on-chain, we unreserve any deposit
         * a user may have paid, and take the control of the preimage out of their hands.
         */
        request_preimage: TxDescriptor<Anonymize<I1jm8m1rh9e20v>>;
        /**
         * Clear a previously made request for a preimage.
         *
         * NOTE: THIS MUST NOT BE CALLED ON `hash` MORE TIMES THAN `request_preimage`.
         */
        unrequest_preimage: TxDescriptor<Anonymize<I1jm8m1rh9e20v>>;
        /**
         * Ensure that the a bulk of pre-images is upgraded.
         *
         * The caller pays no fee if at least 90% of pre-images were successfully updated.
         */
        ensure_updated: TxDescriptor<Anonymize<I3o5j3bli1pd8e>>;
    };
    TxPause: {
        /**
         * Pause a call.
         *
         * Can only be called by [`Config::PauseOrigin`].
         * Emits an [`Event::CallPaused`] event on success.
         */
        pause: TxDescriptor<Anonymize<Iba7pefg0d11kh>>;
        /**
         * Un-pause a call.
         *
         * Can only be called by [`Config::UnpauseOrigin`].
         * Emits an [`Event::CallUnpaused`] event on success.
         */
        unpause: TxDescriptor<Anonymize<I2pjehun5ehh5i>>;
    };
    ImOnline: {
        /**
         * ## Complexity:
         * - `O(K)` where K is length of `Keys` (heartbeat.validators_len)
         * - `O(K)`: decoding of length `K`
         */
        heartbeat: TxDescriptor<Anonymize<I49p1tgb1igk6>>;
    };
    Identity: {
        /**
         * Add a registrar to the system.
         *
         * The dispatch origin for this call must be `T::RegistrarOrigin`.
         *
         * - `account`: the account of the registrar.
         *
         * Emits `RegistrarAdded` if successful.
         */
        add_registrar: TxDescriptor<Anonymize<I73kffnn32g4c7>>;
        /**
         * Set an account's identity information and reserve the appropriate deposit.
         *
         * If the account already has identity information, the deposit is taken as part payment
         * for the new deposit.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * - `info`: The identity information.
         *
         * Emits `IdentitySet` if successful.
         */
        set_identity: TxDescriptor<Anonymize<I2kds5jji7slh8>>;
        /**
         * Set the sub-accounts of the sender.
         *
         * Payment: Any aggregate balance reserved by previous `set_subs` calls will be returned
         * and an amount `SubAccountDeposit` will be reserved for each item in `subs`.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must have a registered
         * identity.
         *
         * - `subs`: The identity's (new) sub-accounts.
         */
        set_subs: TxDescriptor<Anonymize<Ia9mkdf6l44shb>>;
        /**
         * Clear an account's identity info and all sub-accounts and return all deposits.
         *
         * Payment: All reserved balances on the account are returned.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must have a registered
         * identity.
         *
         * Emits `IdentityCleared` if successful.
         */
        clear_identity: TxDescriptor<undefined>;
        /**
         * Request a judgement from a registrar.
         *
         * Payment: At most `max_fee` will be reserved for payment to the registrar if judgement
         * given.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must have a
         * registered identity.
         *
         * - `reg_index`: The index of the registrar whose judgement is requested.
         * - `max_fee`: The maximum fee that may be paid. This should just be auto-populated as:
         *
         * ```nocompile
         * Self::registrars().get(reg_index).unwrap().fee
         * ```
         *
         * Emits `JudgementRequested` if successful.
         */
        request_judgement: TxDescriptor<Anonymize<I9l2s4klu0831o>>;
        /**
         * Cancel a previous request.
         *
         * Payment: A previously reserved deposit is returned on success.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must have a
         * registered identity.
         *
         * - `reg_index`: The index of the registrar whose judgement is no longer requested.
         *
         * Emits `JudgementUnrequested` if successful.
         */
        cancel_request: TxDescriptor<Anonymize<I2ctrt5nqb8o7c>>;
        /**
         * Set the fee required for a judgement to be requested from a registrar.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must be the account
         * of the registrar whose index is `index`.
         *
         * - `index`: the index of the registrar whose fee is to be set.
         * - `fee`: the new fee.
         */
        set_fee: TxDescriptor<Anonymize<I711qahikocb1c>>;
        /**
         * Change the account associated with a registrar.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must be the account
         * of the registrar whose index is `index`.
         *
         * - `index`: the index of the registrar whose fee is to be set.
         * - `new`: the new account ID.
         */
        set_account_id: TxDescriptor<Anonymize<I1u3ac7lafvv5b>>;
        /**
         * Set the field information for a registrar.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must be the account
         * of the registrar whose index is `index`.
         *
         * - `index`: the index of the registrar whose fee is to be set.
         * - `fields`: the fields that the registrar concerns themselves with.
         */
        set_fields: TxDescriptor<Anonymize<Id6gojh30v9ib2>>;
        /**
         * Provide a judgement for an account's identity.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must be the account
         * of the registrar whose index is `reg_index`.
         *
         * - `reg_index`: the index of the registrar whose judgement is being made.
         * - `target`: the account whose identity the judgement is upon. This must be an account
         * with a registered identity.
         * - `judgement`: the judgement of the registrar of index `reg_index` about `target`.
         * - `identity`: The hash of the [`IdentityInformationProvider`] for that the judgement is
         * provided.
         *
         * Note: Judgements do not apply to a username.
         *
         * Emits `JudgementGiven` if successful.
         */
        provide_judgement: TxDescriptor<Anonymize<I9h4cqmadpj7l0>>;
        /**
         * Remove an account's identity and sub-account information and slash the deposits.
         *
         * Payment: Reserved balances from `set_subs` and `set_identity` are slashed and handled by
         * `Slash`. Verification request deposits are not returned; they should be cancelled
         * manually using `cancel_request`.
         *
         * The dispatch origin for this call must match `T::ForceOrigin`.
         *
         * - `target`: the account whose identity the judgement is upon. This must be an account
         * with a registered identity.
         *
         * Emits `IdentityKilled` if successful.
         */
        kill_identity: TxDescriptor<Anonymize<If31vrl50nund3>>;
        /**
         * Add the given account to the sender's subs.
         *
         * Payment: Balance reserved by a previous `set_subs` call for one sub will be repatriated
         * to the sender.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must have a registered
         * sub identity of `sub`.
         */
        add_sub: TxDescriptor<Anonymize<I29bkdd7n16li1>>;
        /**
         * Alter the associated name of the given sub-account.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must have a registered
         * sub identity of `sub`.
         */
        rename_sub: TxDescriptor<Anonymize<I29bkdd7n16li1>>;
        /**
         * Remove the given account from the sender's subs.
         *
         * Payment: Balance reserved by a previous `set_subs` call for one sub will be repatriated
         * to the sender.
         *
         * The dispatch origin for this call must be _Signed_ and the sender must have a registered
         * sub identity of `sub`.
         */
        remove_sub: TxDescriptor<Anonymize<I9jb9hqm18runn>>;
        /**
         * Remove the sender as a sub-account.
         *
         * Payment: Balance reserved by a previous `set_subs` call for one sub will be repatriated
         * to the sender (*not* the original depositor).
         *
         * The dispatch origin for this call must be _Signed_ and the sender must have a registered
         * super-identity.
         *
         * NOTE: This should not normally be used, but is provided in the case that the non-
         * controller of an account is maliciously registered as a sub-account.
         */
        quit_sub: TxDescriptor<undefined>;
        /**
         * Add an `AccountId` with permission to grant usernames with a given `suffix` appended.
         *
         * The authority can grant up to `allocation` usernames. To top up their allocation, they
         * should just issue (or request via governance) a new `add_username_authority` call.
         */
        add_username_authority: TxDescriptor<Anonymize<I85htvo8b885h>>;
        /**
         * Remove `authority` from the username authorities.
         */
        remove_username_authority: TxDescriptor<Anonymize<I95j99om5qfj06>>;
        /**
         * Set the username for `who`. Must be called by a username authority.
         *
         * The authority must have an `allocation`. Users can either pre-sign their usernames or
         * accept them later.
         *
         * Usernames must:
         * - Only contain lowercase ASCII characters or digits.
         * - When combined with the suffix of the issuing authority be _less than_ the
         * `MaxUsernameLength`.
         */
        set_username_for: TxDescriptor<Anonymize<Ifh75tbmlqktju>>;
        /**
         * Accept a given username that an `authority` granted. The call must include the full
         * username, as in `username.suffix`.
         */
        accept_username: TxDescriptor<Anonymize<Ie5l999tf7t2te>>;
        /**
         * Remove an expired username approval. The username was approved by an authority but never
         * accepted by the user and must now be beyond its expiration. The call must include the
         * full username, as in `username.suffix`.
         */
        remove_expired_approval: TxDescriptor<Anonymize<Ie5l999tf7t2te>>;
        /**
         * Set a given username as the primary. The username should include the suffix.
         */
        set_primary_username: TxDescriptor<Anonymize<Ie5l999tf7t2te>>;
        /**
         * Remove a username that corresponds to an account with no identity. Exists when a user
         * gets a username but then calls `clear_identity`.
         */
        remove_dangling_username: TxDescriptor<Anonymize<Ie5l999tf7t2te>>;
    };
    Utility: {
        /**
         * Send a batch of dispatch calls.
         *
         * May be called from any origin except `None`.
         *
         * - `calls`: The calls to be dispatched from the same origin. The number of call must not
         * exceed the constant: `batched_calls_limit` (available in constant metadata).
         *
         * If origin is root then the calls are dispatched without checking origin filter. (This
         * includes bypassing `frame_system::Config::BaseCallFilter`).
         *
         * ## Complexity
         * - O(C) where C is the number of calls to be batched.
         *
         * This will return `Ok` in all circumstances. To determine the success of the batch, an
         * event is deposited. If a call failed and the batch was interrupted, then the
         * `BatchInterrupted` event is deposited, along with the number of successful calls made
         * and the error of the failed call. If all were successful, then the `BatchCompleted`
         * event is deposited.
         */
        batch: TxDescriptor<Anonymize<I835br1ailr092>>;
        /**
         * Send a call through an indexed pseudonym of the sender.
         *
         * Filter from origin are passed along. The call will be dispatched with an origin which
         * use the same filter as the origin of this call.
         *
         * NOTE: If you need to ensure that any account-based filtering is not honored (i.e.
         * because you expect `proxy` to have been used prior in the call stack and you do not want
         * the call restrictions to apply to any sub-accounts), then use `as_multi_threshold_1`
         * in the Multisig pallet instead.
         *
         * NOTE: Prior to version *12, this was called `as_limited_sub`.
         *
         * The dispatch origin for this call must be _Signed_.
         */
        as_derivative: TxDescriptor<Anonymize<I4nknuetu70u1a>>;
        /**
         * Send a batch of dispatch calls and atomically execute them.
         * The whole transaction will rollback and fail if any of the calls failed.
         *
         * May be called from any origin except `None`.
         *
         * - `calls`: The calls to be dispatched from the same origin. The number of call must not
         * exceed the constant: `batched_calls_limit` (available in constant metadata).
         *
         * If origin is root then the calls are dispatched without checking origin filter. (This
         * includes bypassing `frame_system::Config::BaseCallFilter`).
         *
         * ## Complexity
         * - O(C) where C is the number of calls to be batched.
         */
        batch_all: TxDescriptor<Anonymize<I835br1ailr092>>;
        /**
         * Dispatches a function call with a provided origin.
         *
         * The dispatch origin for this call must be _Root_.
         *
         * ## Complexity
         * - O(1).
         */
        dispatch_as: TxDescriptor<Anonymize<Idk4dmbj6bivjh>>;
        /**
         * Send a batch of dispatch calls.
         * Unlike `batch`, it allows errors and won't interrupt.
         *
         * May be called from any origin except `None`.
         *
         * - `calls`: The calls to be dispatched from the same origin. The number of call must not
         * exceed the constant: `batched_calls_limit` (available in constant metadata).
         *
         * If origin is root then the calls are dispatch without checking origin filter. (This
         * includes bypassing `frame_system::Config::BaseCallFilter`).
         *
         * ## Complexity
         * - O(C) where C is the number of calls to be batched.
         */
        force_batch: TxDescriptor<Anonymize<I835br1ailr092>>;
        /**
         * Dispatch a function call with a specified weight.
         *
         * This function does not check the weight of the call, and instead allows the
         * Root origin to specify the weight of the call.
         *
         * The dispatch origin for this call must be _Root_.
         */
        with_weight: TxDescriptor<Anonymize<I46s97719jsq03>>;
    };
    Multisig: {
        /**
         * Immediately dispatch a multi-signature call using a single approval from the caller.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * - `other_signatories`: The accounts (other than the sender) who are part of the
         * multi-signature, but do not participate in the approval process.
         * - `call`: The call to be executed.
         *
         * Result is equivalent to the dispatched result.
         *
         * ## Complexity
         * O(Z + C) where Z is the length of the call and C its execution weight.
         */
        as_multi_threshold_1: TxDescriptor<Anonymize<I4fhhc9mub7uo8>>;
        /**
         * Register approval for a dispatch to be made from a deterministic composite account if
         * approved by a total of `threshold - 1` of `other_signatories`.
         *
         * If there are enough, then dispatch the call.
         *
         * Payment: `DepositBase` will be reserved if this is the first approval, plus
         * `threshold` times `DepositFactor`. It is returned once this dispatch happens or
         * is cancelled.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * - `threshold`: The total number of approvals for this dispatch before it is executed.
         * - `other_signatories`: The accounts (other than the sender) who can approve this
         * dispatch. May not be empty.
         * - `maybe_timepoint`: If this is the first approval, then this must be `None`. If it is
         * not the first approval, then it must be `Some`, with the timepoint (block number and
         * transaction index) of the first approval transaction.
         * - `call`: The call to be executed.
         *
         * NOTE: Unless this is the final approval, you will generally want to use
         * `approve_as_multi` instead, since it only requires a hash of the call.
         *
         * Result is equivalent to the dispatched result if `threshold` is exactly `1`. Otherwise
         * on success, result is `Ok` and the result from the interior call, if it was executed,
         * may be found in the deposited `MultisigExecuted` event.
         *
         * ## Complexity
         * - `O(S + Z + Call)`.
         * - Up to one balance-reserve or unreserve operation.
         * - One passthrough operation, one insert, both `O(S)` where `S` is the number of
         * signatories. `S` is capped by `MaxSignatories`, with weight being proportional.
         * - One call encode & hash, both of complexity `O(Z)` where `Z` is tx-len.
         * - One encode & hash, both of complexity `O(S)`.
         * - Up to one binary search and insert (`O(logS + S)`).
         * - I/O: 1 read `O(S)`, up to 1 mutate `O(S)`. Up to one remove.
         * - One event.
         * - The weight of the `call`.
         * - Storage: inserts one item, value size bounded by `MaxSignatories`, with a deposit
         * taken for its lifetime of `DepositBase + threshold * DepositFactor`.
         */
        as_multi: TxDescriptor<Anonymize<Ijlbhl3lcdb3d>>;
        /**
         * Register approval for a dispatch to be made from a deterministic composite account if
         * approved by a total of `threshold - 1` of `other_signatories`.
         *
         * Payment: `DepositBase` will be reserved if this is the first approval, plus
         * `threshold` times `DepositFactor`. It is returned once this dispatch happens or
         * is cancelled.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * - `threshold`: The total number of approvals for this dispatch before it is executed.
         * - `other_signatories`: The accounts (other than the sender) who can approve this
         * dispatch. May not be empty.
         * - `maybe_timepoint`: If this is the first approval, then this must be `None`. If it is
         * not the first approval, then it must be `Some`, with the timepoint (block number and
         * transaction index) of the first approval transaction.
         * - `call_hash`: The hash of the call to be executed.
         *
         * NOTE: If this is the final approval, you will want to use `as_multi` instead.
         *
         * ## Complexity
         * - `O(S)`.
         * - Up to one balance-reserve or unreserve operation.
         * - One passthrough operation, one insert, both `O(S)` where `S` is the number of
         * signatories. `S` is capped by `MaxSignatories`, with weight being proportional.
         * - One encode & hash, both of complexity `O(S)`.
         * - Up to one binary search and insert (`O(logS + S)`).
         * - I/O: 1 read `O(S)`, up to 1 mutate `O(S)`. Up to one remove.
         * - One event.
         * - Storage: inserts one item, value size bounded by `MaxSignatories`, with a deposit
         * taken for its lifetime of `DepositBase + threshold * DepositFactor`.
         */
        approve_as_multi: TxDescriptor<Anonymize<I44imsiesapsp9>>;
        /**
         * Cancel a pre-existing, on-going multisig transaction. Any deposit reserved previously
         * for this operation will be unreserved on success.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * - `threshold`: The total number of approvals for this dispatch before it is executed.
         * - `other_signatories`: The accounts (other than the sender) who can approve this
         * dispatch. May not be empty.
         * - `timepoint`: The timepoint (block number and transaction index) of the first approval
         * transaction for this dispatch.
         * - `call_hash`: The hash of the call to be executed.
         *
         * ## Complexity
         * - `O(S)`.
         * - Up to one balance-reserve or unreserve operation.
         * - One passthrough operation, one insert, both `O(S)` where `S` is the number of
         * signatories. `S` is capped by `MaxSignatories`, with weight being proportional.
         * - One encode & hash, both of complexity `O(S)`.
         * - One event.
         * - I/O: 1 read `O(S)`, one remove.
         * - Storage: removes one item.
         */
        cancel_as_multi: TxDescriptor<Anonymize<Icr6ao0t0ec3r6>>;
    };
    Ethereum: {
        /**
         * Transact an Ethereum transaction.
         */
        transact: TxDescriptor<Anonymize<Ia8ogbeici6lip>>;
    };
    EVM: {
        /**
         * Withdraw balance from EVM into currency/balances pallet.
         */
        withdraw: TxDescriptor<Anonymize<Idcabvplu05lea>>;
        /**
         * Issue an EVM call operation. This is similar to a message call transaction in Ethereum.
         */
        call: TxDescriptor<Anonymize<I2ncccle6pmhd9>>;
        /**
         * Issue an EVM create operation. This is similar to a contract creation transaction in
         * Ethereum.
         */
        create: TxDescriptor<Anonymize<I92bnd3pe0civj>>;
        /**
         * Issue an EVM create2 operation.
         */
        create2: TxDescriptor<Anonymize<Ic84i538n8bl8j>>;
        /**
        
         */
        set_whitelist: TxDescriptor<Anonymize<I837c61fc07ine>>;
    };
    DynamicFee: {
        /**
        
         */
        note_min_gas_price_target: TxDescriptor<Anonymize<I6v8kghkt0dksl>>;
    };
    BaseFee: {
        /**
        
         */
        set_base_fee_per_gas: TxDescriptor<Anonymize<I7vi74gbubc8u5>>;
        /**
        
         */
        set_elasticity: TxDescriptor<Anonymize<I3u0knmtb1ueq7>>;
    };
    HotfixSufficients: {
        /**
         * Increment `sufficients` for existing accounts having a nonzero `nonce` but zero `sufficients`, `consumers` and `providers` value.
         * This state was caused by a previous bug in EVM create account dispatchable.
         *
         * Any accounts in the input list not satisfying the above condition will remain unaffected.
         */
        hotfix_inc_account_sufficients: TxDescriptor<Anonymize<Ialjbutpk9fktt>>;
    };
    Proxy: {
        /**
         * Dispatch the given `call` from an account that the sender is authorised for through
         * `add_proxy`.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * Parameters:
         * - `real`: The account that the proxy will make a call on behalf of.
         * - `force_proxy_type`: Specify the exact proxy type to be used and checked for this call.
         * - `call`: The call to be made by the `real` account.
         */
        proxy: TxDescriptor<Anonymize<I6857skgbjgbj4>>;
        /**
         * Register a proxy account for the sender that is able to make calls on its behalf.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * Parameters:
         * - `proxy`: The account that the `caller` would like to make a proxy.
         * - `proxy_type`: The permissions allowed for this proxy account.
         * - `delay`: The announcement period required of the initial proxy. Will generally be
         * zero.
         */
        add_proxy: TxDescriptor<Anonymize<Ia2th0jtu8gpfn>>;
        /**
         * Unregister a proxy account for the sender.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * Parameters:
         * - `proxy`: The account that the `caller` would like to remove as a proxy.
         * - `proxy_type`: The permissions currently enabled for the removed proxy account.
         */
        remove_proxy: TxDescriptor<Anonymize<Ia2th0jtu8gpfn>>;
        /**
         * Unregister all proxy accounts for the sender.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * WARNING: This may be called on accounts created by `pure`, however if done, then
         * the unreserved fees will be inaccessible. **All access to this account will be lost.**
         */
        remove_proxies: TxDescriptor<undefined>;
        /**
         * Spawn a fresh new account that is guaranteed to be otherwise inaccessible, and
         * initialize it with a proxy of `proxy_type` for `origin` sender.
         *
         * Requires a `Signed` origin.
         *
         * - `proxy_type`: The type of the proxy that the sender will be registered as over the
         * new account. This will almost always be the most permissive `ProxyType` possible to
         * allow for maximum flexibility.
         * - `index`: A disambiguation index, in case this is called multiple times in the same
         * transaction (e.g. with `utility::batch`). Unless you're using `batch` you probably just
         * want to use `0`.
         * - `delay`: The announcement period required of the initial proxy. Will generally be
         * zero.
         *
         * Fails with `Duplicate` if this has already been called in this transaction, from the
         * same sender, with the same parameters.
         *
         * Fails if there are insufficient funds to pay for deposit.
         */
        create_pure: TxDescriptor<Anonymize<I4fjuo0cog477g>>;
        /**
         * Removes a previously spawned pure proxy.
         *
         * WARNING: **All access to this account will be lost.** Any funds held in it will be
         * inaccessible.
         *
         * Requires a `Signed` origin, and the sender account must have been created by a call to
         * `pure` with corresponding parameters.
         *
         * - `spawner`: The account that originally called `pure` to create this account.
         * - `index`: The disambiguation index originally passed to `pure`. Probably `0`.
         * - `proxy_type`: The proxy type originally passed to `pure`.
         * - `height`: The height of the chain when the call to `pure` was processed.
         * - `ext_index`: The extrinsic index in which the call to `pure` was processed.
         *
         * Fails with `NoPermission` in case the caller is not a previously created pure
         * account whose `pure` call has corresponding parameters.
         */
        kill_pure: TxDescriptor<Anonymize<I623bfqj2uih54>>;
        /**
         * Publish the hash of a proxy-call that will be made in the future.
         *
         * This must be called some number of blocks before the corresponding `proxy` is attempted
         * if the delay associated with the proxy relationship is greater than zero.
         *
         * No more than `MaxPending` announcements may be made at any one time.
         *
         * This will take a deposit of `AnnouncementDepositFactor` as well as
         * `AnnouncementDepositBase` if there are no other pending announcements.
         *
         * The dispatch origin for this call must be _Signed_ and a proxy of `real`.
         *
         * Parameters:
         * - `real`: The account that the proxy will make a call on behalf of.
         * - `call_hash`: The hash of the call to be made by the `real` account.
         */
        announce: TxDescriptor<Anonymize<Idj9faf6hgsdur>>;
        /**
         * Remove a given announcement.
         *
         * May be called by a proxy account to remove a call they previously announced and return
         * the deposit.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * Parameters:
         * - `real`: The account that the proxy will make a call on behalf of.
         * - `call_hash`: The hash of the call to be made by the `real` account.
         */
        remove_announcement: TxDescriptor<Anonymize<Idj9faf6hgsdur>>;
        /**
         * Remove the given announcement of a delegate.
         *
         * May be called by a target (proxied) account to remove a call that one of their delegates
         * (`delegate`) has announced they want to execute. The deposit is returned.
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * Parameters:
         * - `delegate`: The account that previously announced the call.
         * - `call_hash`: The hash of the call to be made.
         */
        reject_announcement: TxDescriptor<Anonymize<I8mj1nm903hpts>>;
        /**
         * Dispatch the given `call` from an account that the sender is authorized for through
         * `add_proxy`.
         *
         * Removes any corresponding announcement(s).
         *
         * The dispatch origin for this call must be _Signed_.
         *
         * Parameters:
         * - `real`: The account that the proxy will make a call on behalf of.
         * - `force_proxy_type`: Specify the exact proxy type to be used and checked for this call.
         * - `call`: The call to be made by the `real` account.
         */
        proxy_announced: TxDescriptor<Anonymize<I7an0d6j0oge8o>>;
    };
    Registration: {
        /**
        
         */
        force_register_coldkey_node: TxDescriptor<Anonymize<Ie08tvgm9uje9n>>;
        /**
        
         */
        register_node_with_coldkey: TxDescriptor<Anonymize<I39b902684r57b>>;
        /**
        
         */
        set_node_status_to_degraded: TxDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
         * Sudo function to enable or disable fee charging
         */
        set_fee_charging: TxDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
         * Sudo function to update the fee for a specific node type
         */
        set_node_type_fee: TxDescriptor<Anonymize<I2oet9jl0tboi4>>;
        /**
        
         */
        set_node_type_disabled: TxDescriptor<Anonymize<Icimuh915fen06>>;
        /**
        
         */
        force_unregister_hotkey_node: TxDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        force_unregister_coldkey_node: TxDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        unregister_node: TxDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        unregister_main_node: TxDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        swap_node_owner: TxDescriptor<Anonymize<Itdoblp90lfe2>>;
        /**
         * Sudo call to unregister all nodes with is_verified = false
         * This will iterate through all registered nodes and unregister those that are not verified
         */
        sudo_unregister_unverified_nodes: TxDescriptor<undefined>;
        /**
        
         */
        submit_deregistration_report: TxDescriptor<Anonymize<If9sojp49tb7bn>>;
        /**
         * Ban or unban an account from registering nodes
         */
        set_account_ban_status: TxDescriptor<Anonymize<I2i9ihlf6tlsua>>;
        /**
         * Set the list of whitelisted validators
         *
         * Can only be called by root.
         */
        set_whitelisted_validators: TxDescriptor<Anonymize<I97hfovkaaqb7h>>;
        /**
        
         */
        verify_existing_node: TxDescriptor<Anonymize<Ibqlvl2pb9t94e>>;
        /**
        
         */
        verify_existing_coldkey_node: TxDescriptor<Anonymize<Ibqlvl2pb9t94e>>;
        /**
         * Toggle the de-registration switch (root only)
         */
        set_deregistration_enabled: TxDescriptor<Anonymize<I94dejtmu6d72i>>;
    };
    ExecutionUnit: {
        /**
        
         */
        add_hardware_info: TxDescriptor<Anonymize<I6367gk7n5srvv>>;
        /**
        
         */
        metrics_data_update: TxDescriptor<Anonymize<I51q1ab7s5ros5>>;
        /**
        
         */
        update_pin_check_metrics: TxDescriptor<Anonymize<Icns9uu67sm2c>>;
        /**
         * Sudo function to enable purging of deregistered nodes
         */
        sudo_enable_purge_deregistered_nodes: TxDescriptor<undefined>;
        /**
         * Sudo function to disable purging of deregistered nodes
         */
        sudo_disable_purge_deregistered_nodes: TxDescriptor<undefined>;
    };
    Metagraph: {
        /**
        
         */
        submit_hot_keys_info: TxDescriptor<Anonymize<Ie3u49lcd7idld>>;
        /**
        
         */
        set_stored_dividends: TxDescriptor<Anonymize<Idjafbm59g1uqh>>;
        /**
         * Sudo function to add a whitelisted validator
         */
        sudo_add_whitelisted_validator: TxDescriptor<Anonymize<I9acqruh7322g2>>;
        /**
         * Sudo function to remove a whitelisted validator
         */
        sudo_remove_whitelisted_validator: TxDescriptor<Anonymize<I9acqruh7322g2>>;
    };
    Marketplace: {
        /**
         * Set the `is_suspended` field for a specific package.
         */
        set_package_suspension: TxDescriptor<Anonymize<I8o0n1n0sdpujr>>;
        /**
        
         */
        storage_request: TxDescriptor<Anonymize<Ibftam0unl1fsq>>;
        /**
        
         */
        storage_unpin_request: TxDescriptor<Anonymize<I7ckaemrn32ju>>;
        /**
         * Sudo function to add a new plan.
         */
        add_new_plan: TxDescriptor<Anonymize<If5mnb2sshko5d>>;
        /**
         * Purchase one or more plans using points
         */
        purchase_plan: TxDescriptor<Anonymize<I8den9qn740oa7>>;
        /**
         * Sudo function to set the price per GB for storage
         */
        set_price_per_gb: TxDescriptor<Anonymize<I6h5nf3idmn898>>;
        /**
         * Sudo function to set the price per GB for storage
         */
        set_bandwidth_price: TxDescriptor<Anonymize<I6h5nf3idmn898>>;
        /**
        
         */
        set_os_disk_image_url: TxDescriptor<Anonymize<Ifoap83itjns41>>;
        /**
         * Set the specific miner request fee
         */
        set_specific_miner_request_fee: TxDescriptor<Anonymize<Ib1ilbm5ipoh62>>;
        /**
        
         */
        deposit: TxDescriptor<Anonymize<I66r1tu4acmi8i>>;
        /**
        
         */
        chargeback: TxDescriptor<Anonymize<I8fe3c4k4rohtd>>;
        /**
        
         */
        set_sudo_key: TxDescriptor<Anonymize<I5pjaoviin0m2>>;
        /**
        
         */
        sudo_set_storage_operations: TxDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
         * Enable or disable purchase plan functionality
         *
         * Can only be called by sudo
         */
        sudo_set_purchase_plan: TxDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
         * User cancels their own subscription
         */
        cancel_my_subscription: TxDescriptor<undefined>;
    };
    SubAccount: {
        /**
         * The origin can add a sub account for the given main account.
         *
         * The origin must be Signed and the sender should have access to 'main'
         *
         * Parameters:
         * - `main`: The address that has a profile associated
         * - `new_sub_account`: The address that will be added as a connected account of 'main'
         *
         * Emits `SubAccountAdded` event when successful.
         *
         * Weight: `O(1)` TODO: Add correct weight
         */
        add_sub_account: TxDescriptor<Anonymize<Ifdpca19a4andf>>;
        /**
         * The origin can remove a sub account for the given main account.
         *
         * The origin must be Signed and the sender should have access to 'main'
         *
         * Can't remove all the connected accounts for a profile
         *
         * Parameters:
         * - `main`: The address that has a profile associated
         * - `sub_account_to_remove`: The address that will be removed as a connected account of
         * 'main'
         *
         * Emits `SubAccountRemoved` event when successful.
         *
         * Weight: `O(1)` TODO: Add correct weight
         */
        remove_sub_account: TxDescriptor<Anonymize<I1jjo47oaa4a7e>>;
        /**
         * Update the role of a sub-account
         *
         * The origin must be Signed and the sender should have access to 'main'
         *
         * Parameters:
         * - `main`: The main account that owns the sub-account
         * - `sub_account`: The sub-account to update
         * - `new_role`: The new role to assign
         *
         * Emits `SubAccountRoleUpdated` event when successful.
         */
        update_sub_account_role: TxDescriptor<Anonymize<Ieijed8jf38v2>>;
    };
    Notifications: {
        /**
         * Send a notification
         */
        send_notification: TxDescriptor<Anonymize<I3ldmjfqravo2c>>;
        /**
         * Mark a notification as read
         */
        mark_as_read: TxDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * Update an existing notification (Sudo only)
         */
        sudo_update_notification: TxDescriptor<Anonymize<I89s5nqb1ge1ue>>;
        /**
        
         */
        ban_account: TxDescriptor<Anonymize<Icbccs0ug47ilf>>;
    };
    AccountProfile: {
        /**
         * Set a hex-encoded string in the public storage
         */
        set_public_item: TxDescriptor<Anonymize<I6ep07oaf1eoa2>>;
        /**
         * Set a hex-encoded string in the private storage
         */
        set_private_item: TxDescriptor<Anonymize<I6ep07oaf1eoa2>>;
        /**
         * Set a unique username for the user
         */
        set_username: TxDescriptor<Anonymize<Ie5l999tf7t2te>>;
        /**
         * Set the Data Public Key for an account
         */
        set_data_public_key: TxDescriptor<Anonymize<I9pf8ji3tn7abh>>;
        /**
         * Set the Message Public Key for an account
         */
        set_message_public_key: TxDescriptor<Anonymize<I9pf8ji3tn7abh>>;
    };
    Utils: {
        /**
        
         */
        set_metagraph_submission_enabled: TxDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
        
         */
        set_weight_submission_enabled: TxDescriptor<Anonymize<I94dejtmu6d72i>>;
    };
    RankingStorage: {
        /**
        
         */
        update_rank_distribution_limit: TxDescriptor<Anonymize<I1il5mj68vvsms>>;
        /**
        
         */
        update_rankings: TxDescriptor<Anonymize<Ifqtvku7shnlle>>;
    };
    RankingCompute: {
        /**
        
         */
        update_rank_distribution_limit: TxDescriptor<Anonymize<I1il5mj68vvsms>>;
        /**
        
         */
        update_rankings: TxDescriptor<Anonymize<Ifqtvku7shnlle>>;
    };
    RankingValidators: {
        /**
        
         */
        update_rank_distribution_limit: TxDescriptor<Anonymize<I1il5mj68vvsms>>;
        /**
        
         */
        update_rankings: TxDescriptor<Anonymize<Ifqtvku7shnlle>>;
    };
    Credits: {
        /**
         * Add a new authority account (only callable by sudo)
         */
        add_authority: TxDescriptor<Anonymize<I2rg5btjrsqec0>>;
        /**
         * Remove an authority account (only callable by sudo)
         */
        remove_authority: TxDescriptor<Anonymize<I2rg5btjrsqec0>>;
        /**
         * Burn credits (only callable by authority accounts)
         */
        burn: TxDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
        
         */
        increase_user_balance: TxDescriptor<Anonymize<I17do9d5rlq72d>>;
        /**
        
         */
        create_referral_code: TxDescriptor<undefined>;
        /**
        
         */
        change_referral_code: TxDescriptor<undefined>;
        /**
         * Mark a locked credit as fulfilled by providing a transaction hash
         *
         * - `origin`: The account that originally locked the credits
         * - `locked_credit_id`: The ID of the locked credit to mark as fulfilled
         * - `tx_hash`: The transaction hash proving fulfillment
         */
        fulfill_locked_credits: TxDescriptor<Anonymize<Ib4e7k10isusrc>>;
        /**
        
         */
        set_lock_period: TxDescriptor<Anonymize<Iclo2qf5jhpbn0>>;
        /**
         * Set the minimum lock amount (only callable by authorized accounts)
         */
        set_min_lock_amount: TxDescriptor<Anonymize<I3qt1hgg4djhgb>>;
        /**
         * Set the alpha price (only callable by authorized accounts)
         */
        set_alpha_price: TxDescriptor<Anonymize<I6h5nf3idmn898>>;
    };
    ContainerRegistry: {
        /**
        
         */
        create_space: TxDescriptor<Anonymize<I37gkv4ibak4u6>>;
        /**
         * Add a member to a space
         */
        add_space_member: TxDescriptor<Anonymize<I6rufhqab68dv7>>;
        /**
        
         */
        add_manifest_head_digest_and_manifest_json_cid: TxDescriptor<Anonymize<I5guamh56257sq>>;
        /**
         * Store digest information (type and CID)
         */
        store_digest_info: TxDescriptor<Anonymize<Ibie35o389u5m5>>;
    };
    AlphaBridge: {
        /**
         * User burns hAlpha to initiate a withdrawal to Bittensor
         *
         * hAlpha is burned immediately - no escrow. If the withdrawal fails,
         * admin can manually mint hAlpha back via `admin_manual_mint`.
         * The recipient on Bittensor is automatically set to the sender's address.
         *
         * # Arguments
         * * `origin` - Must be signed by the user
         * * `amount` - Amount of hAlpha to burn (in halphaRao, u128)
         */
        withdraw: TxDescriptor<Anonymize<I3qt1hgg4djhgb>>;
        /**
         * Guardian attests a deposit (first attestation creates the record)
         *
         * When guardians observe a deposit_request on Bittensor, they call this
         * to vote for crediting hAlpha. First attestation creates the Deposit record.
         * When threshold is reached, hAlpha is credited to recipient.
         *
         * # Arguments
         * * `origin` - Must be signed by a guardian
         * * `request_id` - The deposit request ID from Bittensor
         * * `recipient` - Recipient to credit hAlpha to
         * * `amount` - Amount to credit (in halphaRao)
         * * `nonce` - Nonce from the deposit request (used for ID verification)
         */
        attest_deposit: TxDescriptor<Anonymize<I4enrikluv7ukd>>;
        /**
         * Guardian can cleanup a finalized deposit after TTL
         *
         * # Arguments
         * * `origin` - Must be signed by a guardian
         * * `deposit_id` - The deposit ID to cleanup
         */
        cleanup_deposit: TxDescriptor<Anonymize<I7s3nv09agh2e2>>;
        /**
         * Guardian can cleanup a withdrawal request after TTL (no status check for source records)
         *
         * # Arguments
         * * `origin` - Must be signed by a guardian
         * * `request_id` - The withdrawal request ID to cleanup
         */
        cleanup_withdrawal_request: TxDescriptor<Anonymize<I1f9io740eqir0>>;
        /**
         * Atomically set the guardian set and threshold (sudo/root only)
         *
         * # Arguments
         * * `origin` - Must be root
         * * `guardians` - New guardian set
         * * `approve_threshold` - Minimum guardian votes needed
         */
        set_guardians_and_threshold: TxDescriptor<Anonymize<Iart6p0ogm1a4g>>;
        /**
         * Pause the bridge (sudo/root only)
         */
        pause: TxDescriptor<undefined>;
        /**
         * Unpause the bridge (sudo/root only)
         */
        unpause: TxDescriptor<undefined>;
        /**
         * Set the global mint cap (sudo/root only)
         *
         * # Arguments
         * * `origin` - Must be root
         * * `cap` - Maximum total hAlpha that can be minted
         */
        set_global_mint_cap: TxDescriptor<Anonymize<Ia6i01als4j5u5>>;
        /**
         * Admin sets the cleanup TTL (in blocks)
         *
         * # Arguments
         * * `origin` - Must be root
         * * `ttl_blocks` - TTL in blocks before finalized records can be cleaned up
         */
        set_cleanup_ttl: TxDescriptor<Anonymize<Ial53v9g5go073>>;
        /**
         * Admin sets the minimum withdrawal amount
         *
         * # Arguments
         * * `origin` - Must be root
         * * `amount` - Minimum amount of hAlpha to withdraw (in halphaRao)
         */
        set_min_withdrawal_amount: TxDescriptor<Anonymize<I3qt1hgg4djhgb>>;
        /**
         * Admin cancels a deposit that is stuck (Pending but not reaching threshold)
         *
         * # Pause Behavior
         * Intentionally does NOT check pause state. Admin emergency/recovery
         * functions must remain operational when the bridge is paused, since
         * pausing is the first step in incident response.
         *
         * # Arguments
         * * `origin` - Must be root
         * * `request_id` - The deposit ID to cancel
         * * `reason` - Reason for cancellation
         */
        admin_cancel_deposit: TxDescriptor<Anonymize<I5mdteph6cc9jt>>;
        /**
         * Admin marks a withdrawal request as failed and manually mints hAlpha back
         *
         * This restores the hAlpha that was burned during withdraw(). The mint cap
         * check and TotalMintedByBridge update are performed to maintain accounting.
         *
         * # Pause Behavior
         * Intentionally does NOT check pause state. Admin emergency/recovery
         * functions must remain operational when the bridge is paused, since
         * pausing is the first step in incident response.
         *
         * # Arguments
         * * `origin` - Must be root
         * * `request_id` - The withdrawal request ID to fail
         */
        admin_fail_withdrawal_request: TxDescriptor<Anonymize<I1f9io740eqir0>>;
        /**
         * Admin manually mints hAlpha to a recipient (for emergency recovery)
         *
         * WARNING: This mints new hAlpha that wasn't part of a deposit flow.
         * Only use for emergency recovery. The amount counts toward the mint cap.
         *
         * # Pause Behavior
         * Intentionally does NOT check pause state. Admin emergency/recovery
         * functions must remain operational when the bridge is paused, since
         * pausing is the first step in incident response.
         *
         * # Arguments
         * * `origin` - Must be root
         * * `recipient` - Account to receive hAlpha
         * * `amount` - Amount to mint (in halphaRao)
         * * `deposit_id` - Optional deposit ID for audit trail
         */
        admin_manual_mint: TxDescriptor<Anonymize<Ifkr43tqovhaij>>;
    };
    PalletIp: {
        /**
        
         */
        add_available_vm_ip: TxDescriptor<Anonymize<I91984ic727015>>;
        /**
        
         */
        add_available_hypervisor_ip: TxDescriptor<Anonymize<I91984ic727015>>;
        /**
        
         */
        add_available_client_ip: TxDescriptor<Anonymize<I91984ic727015>>;
        /**
        
         */
        add_available_storage_miner_ip: TxDescriptor<Anonymize<I91984ic727015>>;
        /**
        
         */
        remove_available_vm_ip: TxDescriptor<Anonymize<I91984ic727015>>;
        /**
        
         */
        remove_available_hypervisor_ip: TxDescriptor<Anonymize<I91984ic727015>>;
        /**
        
         */
        remove_available_client_ip: TxDescriptor<Anonymize<I91984ic727015>>;
        /**
        
         */
        remove_available_storage_miner_ip: TxDescriptor<Anonymize<I91984ic727015>>;
    };
    IpfsPallet: {
        /**
         * Sudo function to enable or disable file assignments
         */
        set_pinning_enabled: TxDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
         * Sudo function to enable or disable file assignments
         */
        set_assignment_enabled: TxDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
         * Unsigned transaction to set a miner's state to Locked
         */
        remove_bad_storage_request: TxDescriptor<Anonymize<Iprdg004aleb1>>;
        /**
         * Unsigned transaction to remove a bad unpin request
         */
        remove_bad_unpin_request: TxDescriptor<Anonymize<Iprdg004aleb1>>;
        /**
        
         */
        update_pin_and_storage_requests: TxDescriptor<Anonymize<I4j0crdbqua0qu>>;
        /**
        
         */
        update_unpin_and_storage_requests: TxDescriptor<Anonymize<I26uip050ir8v7>>;
        /**
         * Removes all unpin requests by the specified owner.
         */
        sudo_remove_unpin_requests: TxDescriptor<Anonymize<I2unte8sl8u10d>>;
        /**
        
         */
        remove_rebalance_request: TxDescriptor<Anonymize<Iakdoa23lufqg0>>;
        /**
        
         */
        blacklist_user: TxDescriptor<Anonymize<I6dgvurjgtiomb>>;
        /**
         * Set rotation enabled or disabled (sudo-only)
         */
        set_rotation_whitelisting_enabled: TxDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
        
         */
        clear_all_data: TxDescriptor<undefined>;
        /**
        
         */
        update_miner_profiles: TxDescriptor<Anonymize<I1oh4jsoq9jqr0>>;
        /**
        
         */
        update_user_profiles: TxDescriptor<Anonymize<I95fuqbk5en8j6>>;
        /**
         * Unsigned transaction to clear all unpin requests for a validator node
         */
        clear_all_unpin_requests: TxDescriptor<undefined>;
        /**
        
         */
        close_storage_requests: TxDescriptor<Anonymize<Ib1oa5g7vc8nbc>>;
        /**
        
         */
        close_unpin_requests: TxDescriptor<Anonymize<Ib1oa5g7vc8nbc>>;
        /**
        
         */
        submit_storage_request_for_user: TxDescriptor<Anonymize<I5632otb8qptv2>>;
        /**
        
         */
        submit_unpin_request_for_user: TxDescriptor<Anonymize<Ibffn022ev2pud>>;
    };
    Arion: {
        /**
         * Publish a new CRUSH map for a specific epoch.
         *
         * Expected usage:
         * - Called only when epoch changes.
         * - Miner list MUST be sorted by `uid` ascending and have unique uids.
         *
         * Stores:
         * - `EpochParams[epoch]`
         * - `EpochMiners[epoch]`
         * - `EpochRoot[epoch]` (hash of canonical SCALE encoding)
         * Updates:
         * - `CurrentEpoch`
         */
        submit_crush_map: TxDescriptor<Anonymize<I8npm6laabqo83>>;
        /**
         * Submit aggregated miner stats updates for the current reporting bucket.
         *
         * Suggested: call every N blocks (e.g. 300) with aggregates.
         */
        submit_miner_stats: TxDescriptor<Anonymize<I9946bspu783hd>>;
        /**
         * Register a child node under a family.
         *
         * - **First child free per family (one-time)**.
         * - After that, the required deposit is **global** (network-wide) and **doubles** after each paid registration.
         * - Global deposit **halves** after each `GlobalDepositHalvingPeriodBlocks` of inactivity (lazy, computed on registration).
         * - Requires `node_id` (ed25519 pubkey) to sign a domain-separated payload including a per-node nonce.
         *
         * Signature payload (domain-separated, SCALE-encoded):
         * - ("ARION_NODE_REG_V1", family, child, node_id, nonce)
         */
        register_child: TxDescriptor<Anonymize<I4ir6ck75pcou4>>;
        /**
         * Deregister a child node.
         *
         * Effects:
         * - Child becomes `Unbonding`, removed from active counts
         * - Node id is released from the active registry, but put in cooldown
         * - Deposit remains reserved until `claim_unbonded`
         */
        deregister_child: TxDescriptor<Anonymize<Ie4uqb22ums70>>;
        /**
         * Claim (unbond) the deposit for a deregistered child after the unbonding period.
         *
         * Note: this does NOT bypass cooldown; cooldown is enforced on `register_child`.
         */
        claim_unbonded: TxDescriptor<Anonymize<Ie4uqb22ums70>>;
        /**
         * Submit validator-observed per-node quality metrics and let the pallet compute the final node + family weights.
         *
         * This is the **recommended** path (deterministic on-chain weight calculation).
         */
        submit_node_quality: TxDescriptor<Anonymize<I6tepc53cpcgor>>;
        /**
         * Submit warden proof-of-storage attestations.
         *
         * Attestations are signed audit results from wardens that verify miners
         * are storing the data they claim to store. These are used for:
         * - Reputation scoring
         * - Slashing for failed audits
         * - Rewarding successful storage proofs
         *
         * Expected usage:
         * - Called periodically by the chain-submitter service
         * - Warden signs attestations with Ed25519 keypair
         * - Signature verification is performed on-chain for each attestation
         *
         * # Security
         * - Each attestation signature is verified using Ed25519
         * - Invalid signatures are rejected with InvalidAttestationSignature error
         */
        submit_attestations: TxDescriptor<Anonymize<I7pmn74tpeupjh>>;
        /**
         * Submit an attestation commitment for third-party verification.
         *
         * This stores a compact commitment containing merkle roots and the Arion
         * content hash. Third parties can:
         * 1. Query this commitment from the chain
         * 2. Download the full bundle from Arion using `arion_content_hash`
         * 3. Verify the bundle hash matches
         * 4. Verify attestations against the merkle roots
         *
         * # Parameters
         * - `epoch`: The epoch this commitment covers
         * - `arion_content_hash`: BLAKE3 hash of the SCALE-encoded AttestationBundle (32 bytes)
         * - `attestation_merkle_root`: Merkle root of all attestation leaves
         * - `warden_pubkey_merkle_root`: Merkle root of unique warden public keys
         * - `attestation_count`: Number of attestations in the bundle
         */
        submit_attestation_commitment: TxDescriptor<Anonymize<I8q57m51quft2e>>;
        /**
         * Admin: enable/disable registration lockup (reserve/unbond).
         *
         * Configure `AdminOrigin` as `EnsureRoot` to make this a sudo-only extrinsic.
         */
        set_lockup_enabled: TxDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
         * Admin: set the base deposit price (floor for the global fee curve).
         *
         * Configure `AdminOrigin` as `EnsureRoot` to make this a sudo-only extrinsic.
         *
         * Notes:
         * - This does not overwrite `GlobalNextDeposit` unless it is below the new floor;
         * the next time registration runs, `global_next_deposit_floor_init` will raise it.
         */
        set_base_child_deposit: TxDescriptor<Anonymize<I1fm7b684mo0pb>>;
        /**
         * Admin: Register a warden authorized to submit attestations.
         *
         * Once registered, attestations from this warden's public key will be accepted.
         * Third parties can query `RegisteredWardens[pubkey]` to verify authorization.
         *
         * # Parameters
         * - `warden_pubkey`: The warden's Ed25519 public key (32 bytes)
         */
        register_warden: TxDescriptor<Anonymize<Icsr8fi82ccpe5>>;
        /**
         * Admin: Deregister a warden, preventing future attestation submissions.
         *
         * The warden's registration record is kept for audit purposes but marked as deregistered.
         * Attestations from deregistered wardens will be rejected.
         *
         * # Parameters
         * - `warden_pubkey`: The warden's Ed25519 public key (32 bytes)
         */
        deregister_warden: TxDescriptor<Anonymize<Icsr8fi82ccpe5>>;
        /**
         * Prune old attestation buckets to prevent unbounded storage growth.
         *
         * Removes attestation data for buckets older than `before_bucket`.
         * The `before_bucket` must be at least `AttestationRetentionBuckets` behind
         * the current bucket to prevent accidental pruning of recent data.
         *
         * This is a permissionless operation - anyone can call it to help clean up
         * old attestation data. The retention period ensures recent data is protected.
         *
         * # Parameters
         * - `before_bucket`: Prune all buckets with ID less than this value
         * - `max_buckets`: Maximum number of buckets to prune in this call (for weight limiting)
         */
        prune_attestation_buckets: TxDescriptor<Anonymize<Ifujvbrougmt1u>>;
    };
};
type IEvent = {
    System: {
        /**
         * An extrinsic completed successfully.
         */
        ExtrinsicSuccess: PlainDescriptor<Anonymize<Ia82mnkmeo2rhc>>;
        /**
         * An extrinsic failed.
         */
        ExtrinsicFailed: PlainDescriptor<Anonymize<I3ivcchssriktc>>;
        /**
         * `:code` was updated.
         */
        CodeUpdated: PlainDescriptor<undefined>;
        /**
         * A new account was created.
         */
        NewAccount: PlainDescriptor<Anonymize<Icbccs0ug47ilf>>;
        /**
         * An account was reaped.
         */
        KilledAccount: PlainDescriptor<Anonymize<Icbccs0ug47ilf>>;
        /**
         * On on-chain remark happened.
         */
        Remarked: PlainDescriptor<Anonymize<I855j4i3kr8ko1>>;
        /**
         * An upgrade was authorized.
         */
        UpgradeAuthorized: PlainDescriptor<Anonymize<Ibgl04rn6nbfm6>>;
    };
    Sudo: {
        /**
         * A sudo call just took place.
         */
        Sudid: PlainDescriptor<Anonymize<I548nsjpe0eqli>>;
        /**
         * The sudo key has been updated.
         */
        KeyChanged: PlainDescriptor<Anonymize<I5rtkmhm2dng4u>>;
        /**
         * The key was permanently removed.
         */
        KeyRemoved: PlainDescriptor<undefined>;
        /**
         * A [sudo_as](Pallet::sudo_as) call just took place.
         */
        SudoAsDone: PlainDescriptor<Anonymize<I548nsjpe0eqli>>;
    };
    Assets: {
        /**
         * Some asset class was created.
         */
        Created: PlainDescriptor<Anonymize<I2f09r4lf5jjh9>>;
        /**
         * Some assets were issued.
         */
        Issued: PlainDescriptor<Anonymize<If6m0o1bjubses>>;
        /**
         * Some assets were transferred.
         */
        Transferred: PlainDescriptor<Anonymize<Ica4tsd7r045b4>>;
        /**
         * Some assets were destroyed.
         */
        Burned: PlainDescriptor<Anonymize<I8lqcc9n1bpf10>>;
        /**
         * The management team changed.
         */
        TeamChanged: PlainDescriptor<Anonymize<Ic756ll6rev3et>>;
        /**
         * The owner changed.
         */
        OwnerChanged: PlainDescriptor<Anonymize<Iabgjddlh1k1hp>>;
        /**
         * Some account `who` was frozen.
         */
        Frozen: PlainDescriptor<Anonymize<Ie04jjjrr8q02l>>;
        /**
         * Some account `who` was thawed.
         */
        Thawed: PlainDescriptor<Anonymize<Ie04jjjrr8q02l>>;
        /**
         * Some asset `asset_id` was frozen.
         */
        AssetFrozen: PlainDescriptor<Anonymize<Ib9karr24cpmca>>;
        /**
         * Some asset `asset_id` was thawed.
         */
        AssetThawed: PlainDescriptor<Anonymize<Ib9karr24cpmca>>;
        /**
         * Accounts were destroyed for given asset.
         */
        AccountsDestroyed: PlainDescriptor<Anonymize<Ifstva0urnm27g>>;
        /**
         * Approvals were destroyed for given asset.
         */
        ApprovalsDestroyed: PlainDescriptor<Anonymize<I4lpo3encq7fn8>>;
        /**
         * An asset class is in the process of being destroyed.
         */
        DestructionStarted: PlainDescriptor<Anonymize<Ib9karr24cpmca>>;
        /**
         * An asset class was destroyed.
         */
        Destroyed: PlainDescriptor<Anonymize<Ib9karr24cpmca>>;
        /**
         * Some asset class was force-created.
         */
        ForceCreated: PlainDescriptor<Anonymize<Iabgjddlh1k1hp>>;
        /**
         * New metadata has been set for an asset.
         */
        MetadataSet: PlainDescriptor<Anonymize<Icd1cghie6s8nr>>;
        /**
         * Metadata has been cleared for an asset.
         */
        MetadataCleared: PlainDescriptor<Anonymize<Ib9karr24cpmca>>;
        /**
         * (Additional) funds have been approved for transfer to a destination account.
         */
        ApprovedTransfer: PlainDescriptor<Anonymize<I7vvm3he225ppt>>;
        /**
         * An approval for account `delegate` was cancelled by `owner`.
         */
        ApprovalCancelled: PlainDescriptor<Anonymize<Iaui349lsh3clk>>;
        /**
         * An `amount` was transferred in its entirety from `owner` to `destination` by
         * the approved `delegate`.
         */
        TransferredApproved: PlainDescriptor<Anonymize<Ifbddfv84nkppg>>;
        /**
         * An asset has had its attributes changed by the `Force` origin.
         */
        AssetStatusChanged: PlainDescriptor<Anonymize<Ib9karr24cpmca>>;
        /**
         * The min_balance of an asset has been updated by the asset owner.
         */
        AssetMinBalanceChanged: PlainDescriptor<Anonymize<Iil3sdsh8fk7l>>;
        /**
         * Some account `who` was created with a deposit from `depositor`.
         */
        Touched: PlainDescriptor<Anonymize<I85i3hdo5nsfi5>>;
        /**
         * Some account `who` was blocked.
         */
        Blocked: PlainDescriptor<Anonymize<Ie04jjjrr8q02l>>;
        /**
         * Some assets were deposited (e.g. for transaction fees).
         */
        Deposited: PlainDescriptor<Anonymize<Ic65advfoqjhk7>>;
        /**
         * Some assets were withdrawn from the account (e.g. for transaction fees).
         */
        Withdrawn: PlainDescriptor<Anonymize<Ic65advfoqjhk7>>;
    };
    Balances: {
        /**
         * An account was created with some free balance.
         */
        Endowed: PlainDescriptor<Anonymize<Icv68aq8841478>>;
        /**
         * An account was removed whose balance was non-zero but below ExistentialDeposit,
         * resulting in an outright loss.
         */
        DustLost: PlainDescriptor<Anonymize<Ic262ibdoec56a>>;
        /**
         * Transfer succeeded.
         */
        Transfer: PlainDescriptor<Anonymize<Iflcfm9b6nlmdd>>;
        /**
         * A balance was set by root.
         */
        BalanceSet: PlainDescriptor<Anonymize<Ijrsf4mnp3eka>>;
        /**
         * Some balance was reserved (moved from free to reserved).
         */
        Reserved: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Some balance was unreserved (moved from reserved to free).
         */
        Unreserved: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Some balance was moved from the reserve of the first account to the second account.
         * Final argument indicates the destination balance type.
         */
        ReserveRepatriated: PlainDescriptor<Anonymize<I8tjvj9uq4b7hi>>;
        /**
         * Some amount was deposited (e.g. for transaction fees).
         */
        Deposit: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Some amount was withdrawn from the account (e.g. for transaction fees).
         */
        Withdraw: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Some amount was removed from the account (e.g. for misbehavior).
         */
        Slashed: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Some amount was minted into an account.
         */
        Minted: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Some amount was burned from an account.
         */
        Burned: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Some amount was suspended from an account (it can be restored later).
         */
        Suspended: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Some amount was restored into an account.
         */
        Restored: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * An account was upgraded.
         */
        Upgraded: PlainDescriptor<Anonymize<I4cbvqmqadhrea>>;
        /**
         * Total issuance was increased by `amount`, creating a credit to be balanced.
         */
        Issued: PlainDescriptor<Anonymize<I3qt1hgg4djhgb>>;
        /**
         * Total issuance was decreased by `amount`, creating a debt to be balanced.
         */
        Rescinded: PlainDescriptor<Anonymize<I3qt1hgg4djhgb>>;
        /**
         * Some balance was locked.
         */
        Locked: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Some balance was unlocked.
         */
        Unlocked: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Some balance was frozen.
         */
        Frozen: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Some balance was thawed.
         */
        Thawed: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * The `TotalIssuance` was forcefully changed.
         */
        TotalIssuanceForced: PlainDescriptor<Anonymize<I4fooe9dun9o0t>>;
    };
    TransactionPayment: {
        /**
         * A transaction fee `actual_fee`, of which `tip` was added to the minimum inclusion fee,
         * has been paid by `who`.
         */
        TransactionFeePaid: PlainDescriptor<Anonymize<Ier2cke86dqbr2>>;
    };
    Grandpa: {
        /**
         * New authority set has been applied.
         */
        NewAuthorities: PlainDescriptor<Anonymize<I5768ac424h061>>;
        /**
         * Current authority set has been paused.
         */
        Paused: PlainDescriptor<undefined>;
        /**
         * Current authority set has been resumed.
         */
        Resumed: PlainDescriptor<undefined>;
    };
    Indices: {
        /**
         * A account index was assigned.
         */
        IndexAssigned: PlainDescriptor<Anonymize<Ia1u3jll6a06ae>>;
        /**
         * A account index has been freed up (unassigned).
         */
        IndexFreed: PlainDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * A account index has been frozen to its current account ID.
         */
        IndexFrozen: PlainDescriptor<Anonymize<Ia1u3jll6a06ae>>;
    };
    Democracy: {
        /**
         * A motion has been proposed by a public account.
         */
        Proposed: PlainDescriptor<Anonymize<I3peh714diura8>>;
        /**
         * A public proposal has been tabled for referendum vote.
         */
        Tabled: PlainDescriptor<Anonymize<I3peh714diura8>>;
        /**
         * An external proposal has been tabled.
         */
        ExternalTabled: PlainDescriptor<undefined>;
        /**
         * A referendum has begun.
         */
        Started: PlainDescriptor<Anonymize<I62ffgu6q2478o>>;
        /**
         * A proposal has been approved by referendum.
         */
        Passed: PlainDescriptor<Anonymize<Ied9mja4bq7va8>>;
        /**
         * A proposal has been rejected by referendum.
         */
        NotPassed: PlainDescriptor<Anonymize<Ied9mja4bq7va8>>;
        /**
         * A referendum has been cancelled.
         */
        Cancelled: PlainDescriptor<Anonymize<Ied9mja4bq7va8>>;
        /**
         * An account has delegated their vote to another account.
         */
        Delegated: PlainDescriptor<Anonymize<I10r7il4gvbcae>>;
        /**
         * An account has cancelled a previous delegation operation.
         */
        Undelegated: PlainDescriptor<Anonymize<Icbccs0ug47ilf>>;
        /**
         * An external proposal has been vetoed.
         */
        Vetoed: PlainDescriptor<Anonymize<I5bb5d1095hgr4>>;
        /**
         * A proposal_hash has been blacklisted permanently.
         */
        Blacklisted: PlainDescriptor<Anonymize<I2ev73t79f46tb>>;
        /**
         * An account has voted in a referendum
         */
        Voted: PlainDescriptor<Anonymize<Iet7kfijhihjik>>;
        /**
         * An account has seconded a proposal
         */
        Seconded: PlainDescriptor<Anonymize<I2vrbos7ogo6ps>>;
        /**
         * A proposal got canceled.
         */
        ProposalCanceled: PlainDescriptor<Anonymize<I9mnj4k4u8ls2c>>;
        /**
         * Metadata for a proposal or a referendum has been set.
         */
        MetadataSet: PlainDescriptor<Anonymize<Iffeo46j957abe>>;
        /**
         * Metadata for a proposal or a referendum has been cleared.
         */
        MetadataCleared: PlainDescriptor<Anonymize<Iffeo46j957abe>>;
        /**
         * Metadata has been transferred to new owner.
         */
        MetadataTransferred: PlainDescriptor<Anonymize<I4ljshcevmm3p2>>;
    };
    Council: {
        /**
         * A motion (given hash) has been proposed (by given account) with a threshold (given
         * `MemberCount`).
         */
        Proposed: PlainDescriptor<Anonymize<Ift6f10887nk72>>;
        /**
         * A motion (given hash) has been voted on by given account, leaving
         * a tally (yes votes and no votes given respectively as `MemberCount`).
         */
        Voted: PlainDescriptor<Anonymize<I7qc53b1tvqjg2>>;
        /**
         * A motion was approved by the required threshold.
         */
        Approved: PlainDescriptor<Anonymize<I2ev73t79f46tb>>;
        /**
         * A motion was not approved by the required threshold.
         */
        Disapproved: PlainDescriptor<Anonymize<I2ev73t79f46tb>>;
        /**
         * A motion was executed; result will be `Ok` if it returned without error.
         */
        Executed: PlainDescriptor<Anonymize<Ie4reroenbg6hl>>;
        /**
         * A single member did some action; result will be `Ok` if it returned without error.
         */
        MemberExecuted: PlainDescriptor<Anonymize<Ie4reroenbg6hl>>;
        /**
         * A proposal was closed because its threshold was reached or after its duration was up.
         */
        Closed: PlainDescriptor<Anonymize<Iak7fhrgb9jnnq>>;
    };
    Vesting: {
        /**
         * The amount vested has been updated. This could indicate a change in funds available.
         * The balance given is the amount which is left unvested (and thus locked).
         */
        VestingUpdated: PlainDescriptor<Anonymize<Ievr89968437gm>>;
        /**
         * An \[account\] has become fully vested.
         */
        VestingCompleted: PlainDescriptor<Anonymize<Icbccs0ug47ilf>>;
    };
    Elections: {
        /**
         * A new term with new_members. This indicates that enough candidates existed to run
         * the election, not that enough have has been elected. The inner value must be examined
         * for this purpose. A `NewTerm(\[\])` indicates that some candidates got their bond
         * slashed and none were elected, whilst `EmptyTerm` means that no candidates existed to
         * begin with.
         */
        NewTerm: PlainDescriptor<Anonymize<Iaofef34v2445a>>;
        /**
         * No (or not enough) candidates existed for this round. This is different from
         * `NewTerm(\[\])`. See the description of `NewTerm`.
         */
        EmptyTerm: PlainDescriptor<undefined>;
        /**
         * Internal error happened while trying to perform election.
         */
        ElectionError: PlainDescriptor<undefined>;
        /**
         * A member has been removed. This should always be followed by either `NewTerm` or
         * `EmptyTerm`.
         */
        MemberKicked: PlainDescriptor<Anonymize<Ie3gphha4ejh40>>;
        /**
         * Someone has renounced their candidacy.
         */
        Renounced: PlainDescriptor<Anonymize<I4b66js88p45m8>>;
        /**
         * A candidate was slashed by amount due to failing to obtain a seat as member or
         * runner-up.
         *
         * Note that old members and runners-up are also candidates.
         */
        CandidateSlashed: PlainDescriptor<Anonymize<I50d9r8lrdga93>>;
        /**
         * A seat holder was slashed by amount by being forcefully removed from the set.
         */
        SeatHolderSlashed: PlainDescriptor<Anonymize<I27avf13g71mla>>;
    };
    ElectionProviderMultiPhase: {
        /**
         * A solution was stored with the given compute.
         *
         * The `origin` indicates the origin of the solution. If `origin` is `Some(AccountId)`,
         * the stored solution was submitted in the signed phase by a miner with the `AccountId`.
         * Otherwise, the solution was stored either during the unsigned phase or by
         * `T::ForceOrigin`. The `bool` is `true` when a previous solution was ejected to make
         * room for this one.
         */
        SolutionStored: PlainDescriptor<Anonymize<I4mol6k10mv0io>>;
        /**
         * The election has been finalized, with the given computation and score.
         */
        ElectionFinalized: PlainDescriptor<Anonymize<Iec90vukseit9e>>;
        /**
         * An election failed.
         *
         * Not much can be said about which computes failed in the process.
         */
        ElectionFailed: PlainDescriptor<undefined>;
        /**
         * An account has been rewarded for their signed submission being finalized.
         */
        Rewarded: PlainDescriptor<Anonymize<I7j4m7a3pkvsf4>>;
        /**
         * An account has been slashed for submitting an invalid signed submission.
         */
        Slashed: PlainDescriptor<Anonymize<I7j4m7a3pkvsf4>>;
        /**
         * There was a phase transition in a given round.
         */
        PhaseTransitioned: PlainDescriptor<Anonymize<Ie732teo48djnq>>;
    };
    Staking: {
        /**
         * The era payout has been set; the first balance is the validator-payout; the second is
         * the remainder from the maximum amount of reward.
         */
        EraPaid: PlainDescriptor<Anonymize<I1au3fq4n84nv3>>;
        /**
         * The nominator has been rewarded by this amount to this destination.
         */
        Rewarded: PlainDescriptor<Anonymize<Iejaj7m7qka9tr>>;
        /**
         * A staker (validator or nominator) has been slashed by the given amount.
         */
        Slashed: PlainDescriptor<Anonymize<Idnak900lt5lm8>>;
        /**
         * A slash for the given validator, for the given percentage of their stake, at the given
         * era as been reported.
         */
        SlashReported: PlainDescriptor<Anonymize<I27n7lbd66730p>>;
        /**
         * An old slashing report from a prior era was discarded because it could
         * not be processed.
         */
        OldSlashingReportDiscarded: PlainDescriptor<Anonymize<I2hq50pu2kdjpo>>;
        /**
         * A new set of stakers was elected.
         */
        StakersElected: PlainDescriptor<undefined>;
        /**
         * An account has bonded this amount. \[stash, amount\]
         *
         * NOTE: This event is only emitted when funds are bonded via a dispatchable. Notably,
         * it will not be emitted for staking rewards when they are added to stake.
         */
        Bonded: PlainDescriptor<Anonymize<Ifk8eme5o7mukf>>;
        /**
         * An account has unbonded this amount.
         */
        Unbonded: PlainDescriptor<Anonymize<Ifk8eme5o7mukf>>;
        /**
         * An account has called `withdraw_unbonded` and removed unbonding chunks worth `Balance`
         * from the unlocking queue.
         */
        Withdrawn: PlainDescriptor<Anonymize<Ifk8eme5o7mukf>>;
        /**
         * A nominator has been kicked from a validator.
         */
        Kicked: PlainDescriptor<Anonymize<Iau4cgm6ih61cf>>;
        /**
         * The election failed. No new era is planned.
         */
        StakingElectionFailed: PlainDescriptor<undefined>;
        /**
         * An account has stopped participating as either a validator or nominator.
         */
        Chilled: PlainDescriptor<Anonymize<Idl3umm12u5pa>>;
        /**
         * The stakers' rewards are getting paid.
         */
        PayoutStarted: PlainDescriptor<Anonymize<I6ir616rur362k>>;
        /**
         * A validator has set their preferences.
         */
        ValidatorPrefsSet: PlainDescriptor<Anonymize<Ic19as7nbst738>>;
        /**
         * Voters size limit reached.
         */
        SnapshotVotersSizeExceeded: PlainDescriptor<Anonymize<I54umskavgc9du>>;
        /**
         * Targets size limit reached.
         */
        SnapshotTargetsSizeExceeded: PlainDescriptor<Anonymize<I54umskavgc9du>>;
        /**
         * A new force era mode was set.
         */
        ForceEra: PlainDescriptor<Anonymize<I2ip7o9e2tc5sf>>;
        /**
         * Report of a controller batch deprecation.
         */
        ControllerBatchDeprecated: PlainDescriptor<Anonymize<I5egvk6hadac5h>>;
    };
    Session: {
        /**
         * New session has happened. Note that the argument is the session index, not the
         * block number as the type might suggest.
         */
        NewSession: PlainDescriptor<Anonymize<I2hq50pu2kdjpo>>;
    };
    Treasury: {
        /**
         * We have ended a spend period and will now allocate funds.
         */
        Spending: PlainDescriptor<Anonymize<I8iksqi3eani0a>>;
        /**
         * Some funds have been allocated.
         */
        Awarded: PlainDescriptor<Anonymize<I16enopmju1p0q>>;
        /**
         * Some of our funds have been burnt.
         */
        Burnt: PlainDescriptor<Anonymize<I43kq8qudg7pq9>>;
        /**
         * Spending has finished; this is the amount that rolls over until next spend.
         */
        Rollover: PlainDescriptor<Anonymize<I76riseemre533>>;
        /**
         * Some funds have been deposited.
         */
        Deposit: PlainDescriptor<Anonymize<Ie5v6njpckr05b>>;
        /**
         * A new spend proposal has been approved.
         */
        SpendApproved: PlainDescriptor<Anonymize<I38bmcrmh852rk>>;
        /**
         * The inactive funds of the pallet have been updated.
         */
        UpdatedInactive: PlainDescriptor<Anonymize<I4hcillge8de5f>>;
        /**
         * A new asset spend proposal has been approved.
         */
        AssetSpendApproved: PlainDescriptor<Anonymize<I3pitp3nlr696e>>;
        /**
         * An approved spend was voided.
         */
        AssetSpendVoided: PlainDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * A payment happened.
         */
        Paid: PlainDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * A payment failed and can be retried.
         */
        PaymentFailed: PlainDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * A spend was processed and removed from the storage. It might have been successfully
         * paid or it may have expired.
         */
        SpendProcessed: PlainDescriptor<Anonymize<I666bl2fqjkejo>>;
    };
    Bounties: {
        /**
         * New bounty proposal.
         */
        BountyProposed: PlainDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * A bounty proposal was rejected; funds were slashed.
         */
        BountyRejected: PlainDescriptor<Anonymize<Id9idaj83175f9>>;
        /**
         * A bounty proposal is funded and became active.
         */
        BountyBecameActive: PlainDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * A bounty is awarded to a beneficiary.
         */
        BountyAwarded: PlainDescriptor<Anonymize<Ie1semicfuv5uu>>;
        /**
         * A bounty is claimed by beneficiary.
         */
        BountyClaimed: PlainDescriptor<Anonymize<If25fjs9o37co1>>;
        /**
         * A bounty is cancelled.
         */
        BountyCanceled: PlainDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * A bounty expiry is extended.
         */
        BountyExtended: PlainDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * A bounty is approved.
         */
        BountyApproved: PlainDescriptor<Anonymize<I666bl2fqjkejo>>;
        /**
         * A bounty curator is proposed.
         */
        CuratorProposed: PlainDescriptor<Anonymize<I70sc1pdo8vtos>>;
        /**
         * A bounty curator is unassigned.
         */
        CuratorUnassigned: PlainDescriptor<Anonymize<Ia9p5bg6p18r0i>>;
        /**
         * A bounty curator is accepted.
         */
        CuratorAccepted: PlainDescriptor<Anonymize<I70sc1pdo8vtos>>;
    };
    ChildBounties: {
        /**
         * A child-bounty is added.
         */
        Added: PlainDescriptor<Anonymize<I60p8l86a8cm59>>;
        /**
         * A child-bounty is awarded to a beneficiary.
         */
        Awarded: PlainDescriptor<Anonymize<I3m3sk2lgcabvp>>;
        /**
         * A child-bounty is claimed by beneficiary.
         */
        Claimed: PlainDescriptor<Anonymize<I5pf572duh4oeg>>;
        /**
         * A child-bounty is cancelled.
         */
        Canceled: PlainDescriptor<Anonymize<I60p8l86a8cm59>>;
    };
    BagsList: {
        /**
         * Moved an account from one bag to another.
         */
        Rebagged: PlainDescriptor<Anonymize<I37454vatvmm1l>>;
        /**
         * Updated the score of some account to the given amount.
         */
        ScoreUpdated: PlainDescriptor<Anonymize<Iblau1qa7u7fet>>;
    };
    NominationPools: {
        /**
         * A pool has been created.
         */
        Created: PlainDescriptor<Anonymize<I1ti389kf8t6oi>>;
        /**
         * A member has became bonded in a pool.
         */
        Bonded: PlainDescriptor<Anonymize<If4nnre373amul>>;
        /**
         * A payout has been made to a member.
         */
        PaidOut: PlainDescriptor<Anonymize<I55kbor0ocqk6h>>;
        /**
         * A member has unbonded from their pool.
         *
         * - `balance` is the corresponding balance of the number of points that has been
         * requested to be unbonded (the argument of the `unbond` transaction) from the bonded
         * pool.
         * - `points` is the number of points that are issued as a result of `balance` being
         * dissolved into the corresponding unbonding pool.
         * - `era` is the era in which the balance will be unbonded.
         * In the absence of slashing, these values will match. In the presence of slashing, the
         * number of points that are issued in the unbonding pool will be less than the amount
         * requested to be unbonded.
         */
        Unbonded: PlainDescriptor<Anonymize<Idsj9cg7j96kpc>>;
        /**
         * A member has withdrawn from their pool.
         *
         * The given number of `points` have been dissolved in return of `balance`.
         *
         * Similar to `Unbonded` event, in the absence of slashing, the ratio of point to balance
         * will be 1.
         */
        Withdrawn: PlainDescriptor<Anonymize<Ido4u9drncfaml>>;
        /**
         * A pool has been destroyed.
         */
        Destroyed: PlainDescriptor<Anonymize<I931cottvong90>>;
        /**
         * The state of a pool has changed
         */
        StateChanged: PlainDescriptor<Anonymize<Ie8c7ctks8ur2p>>;
        /**
         * A member has been removed from a pool.
         *
         * The removal can be voluntary (withdrawn all unbonded funds) or involuntary (kicked).
         */
        MemberRemoved: PlainDescriptor<Anonymize<I7vqogd77mmdlm>>;
        /**
         * The roles of a pool have been updated to the given new roles. Note that the depositor
         * can never change.
         */
        RolesUpdated: PlainDescriptor<Anonymize<I6mik29s5073td>>;
        /**
         * The active balance of pool `pool_id` has been slashed to `balance`.
         */
        PoolSlashed: PlainDescriptor<Anonymize<I2m0sqmb75cnpb>>;
        /**
         * The unbond pool at `era` of pool `pool_id` has been slashed to `balance`.
         */
        UnbondingPoolSlashed: PlainDescriptor<Anonymize<I49agc5b62mehu>>;
        /**
         * A pool's commission setting has been changed.
         */
        PoolCommissionUpdated: PlainDescriptor<Anonymize<Iatq9jda4hq6pg>>;
        /**
         * A pool's maximum commission setting has been changed.
         */
        PoolMaxCommissionUpdated: PlainDescriptor<Anonymize<I8cbluptqo8kbp>>;
        /**
         * A pool's commission `change_rate` has been changed.
         */
        PoolCommissionChangeRateUpdated: PlainDescriptor<Anonymize<I6t5r359eagicn>>;
        /**
         * Pool commission claim permission has been updated.
         */
        PoolCommissionClaimPermissionUpdated: PlainDescriptor<Anonymize<I3ihan8icf0c5k>>;
        /**
         * Pool commission has been claimed.
         */
        PoolCommissionClaimed: PlainDescriptor<Anonymize<I2g87evcjlgmqi>>;
        /**
         * Topped up deficit in frozen ED of the reward pool.
         */
        MinBalanceDeficitAdjusted: PlainDescriptor<Anonymize<Ieg1oc56mamrl5>>;
        /**
         * Claimed excess frozen ED of af the reward pool.
         */
        MinBalanceExcessAdjusted: PlainDescriptor<Anonymize<Ieg1oc56mamrl5>>;
    };
    Scheduler: {
        /**
         * Scheduled some task.
         */
        Scheduled: PlainDescriptor<Anonymize<I229jvdlbdhm94>>;
        /**
         * Canceled some task.
         */
        Canceled: PlainDescriptor<Anonymize<I229jvdlbdhm94>>;
        /**
         * Dispatched some task.
         */
        Dispatched: PlainDescriptor<Anonymize<I4q514k7hotnla>>;
        /**
         * Set a retry configuration for some task.
         */
        RetrySet: PlainDescriptor<Anonymize<I349gm6qoac50o>>;
        /**
         * Cancel a retry configuration for some task.
         */
        RetryCancelled: PlainDescriptor<Anonymize<I4cdcnl6pft57b>>;
        /**
         * The call for the provided hash was not found so the task has been aborted.
         */
        CallUnavailable: PlainDescriptor<Anonymize<I4cdcnl6pft57b>>;
        /**
         * The given task was unable to be renewed since the agenda is full at that block.
         */
        PeriodicFailed: PlainDescriptor<Anonymize<I4cdcnl6pft57b>>;
        /**
         * The given task was unable to be retried since the agenda is full at that block or there
         * was not enough weight to reschedule it.
         */
        RetryFailed: PlainDescriptor<Anonymize<I4cdcnl6pft57b>>;
        /**
         * The given task can never be executed since it is overweight.
         */
        PermanentlyOverweight: PlainDescriptor<Anonymize<I4cdcnl6pft57b>>;
    };
    Preimage: {
        /**
         * A preimage has been noted.
         */
        Noted: PlainDescriptor<Anonymize<I1jm8m1rh9e20v>>;
        /**
         * A preimage has been requested.
         */
        Requested: PlainDescriptor<Anonymize<I1jm8m1rh9e20v>>;
        /**
         * A preimage has ben cleared.
         */
        Cleared: PlainDescriptor<Anonymize<I1jm8m1rh9e20v>>;
    };
    Offences: {
        /**
         * There is an offence reported of the given `kind` happened at the `session_index` and
         * (kind-specific) time slot. This event is not deposited for duplicate slashes.
         * \[kind, timeslot\].
         */
        Offence: PlainDescriptor<Anonymize<Iempvdlhc5ih6g>>;
    };
    TxPause: {
        /**
         * This pallet, or a specific call is now paused.
         */
        CallPaused: PlainDescriptor<Anonymize<Iba7pefg0d11kh>>;
        /**
         * This pallet, or a specific call is now unpaused.
         */
        CallUnpaused: PlainDescriptor<Anonymize<Iba7pefg0d11kh>>;
    };
    ImOnline: {
        /**
         * A new heartbeat was received from `AuthorityId`.
         */
        HeartbeatReceived: PlainDescriptor<Anonymize<I6niuoceqveh04>>;
        /**
         * At the end of the session, no offence was committed.
         */
        AllGood: PlainDescriptor<undefined>;
        /**
         * At the end of the session, at least one validator was found to be offline.
         */
        SomeOffline: PlainDescriptor<Anonymize<I311vp8270bfmr>>;
    };
    Identity: {
        /**
         * A name was set or reset (which will remove all judgements).
         */
        IdentitySet: PlainDescriptor<Anonymize<I4cbvqmqadhrea>>;
        /**
         * A name was cleared, and the given balance returned.
         */
        IdentityCleared: PlainDescriptor<Anonymize<Iep1lmt6q3s6r3>>;
        /**
         * A name was removed and the given balance slashed.
         */
        IdentityKilled: PlainDescriptor<Anonymize<Iep1lmt6q3s6r3>>;
        /**
         * A judgement was asked from a registrar.
         */
        JudgementRequested: PlainDescriptor<Anonymize<I1fac16213rie2>>;
        /**
         * A judgement request was retracted.
         */
        JudgementUnrequested: PlainDescriptor<Anonymize<I1fac16213rie2>>;
        /**
         * A judgement was given by a registrar.
         */
        JudgementGiven: PlainDescriptor<Anonymize<Ifjt77oc391o43>>;
        /**
         * A registrar was added.
         */
        RegistrarAdded: PlainDescriptor<Anonymize<Itvt1jsipv0lc>>;
        /**
         * A sub-identity was added to an identity and the deposit paid.
         */
        SubIdentityAdded: PlainDescriptor<Anonymize<Ick3mveut33f44>>;
        /**
         * A sub-identity was removed from an identity and the deposit freed.
         */
        SubIdentityRemoved: PlainDescriptor<Anonymize<Ick3mveut33f44>>;
        /**
         * A sub-identity was cleared, and the given deposit repatriated from the
         * main identity account to the sub-identity account.
         */
        SubIdentityRevoked: PlainDescriptor<Anonymize<Ick3mveut33f44>>;
        /**
         * A username authority was added.
         */
        AuthorityAdded: PlainDescriptor<Anonymize<I2rg5btjrsqec0>>;
        /**
         * A username authority was removed.
         */
        AuthorityRemoved: PlainDescriptor<Anonymize<I2rg5btjrsqec0>>;
        /**
         * A username was set for `who`.
         */
        UsernameSet: PlainDescriptor<Anonymize<Ibdqerrooruuq9>>;
        /**
         * A username was queued, but `who` must accept it prior to `expiration`.
         */
        UsernameQueued: PlainDescriptor<Anonymize<Ifb1u4u75pnv4d>>;
        /**
         * A queued username passed its expiration without being claimed and was removed.
         */
        PreapprovalExpired: PlainDescriptor<Anonymize<I7ieadb293k6b4>>;
        /**
         * A username was set as a primary and can be looked up from `who`.
         */
        PrimaryUsernameSet: PlainDescriptor<Anonymize<Ibdqerrooruuq9>>;
        /**
         * A dangling username (as in, a username corresponding to an account that has removed its
         * identity) has been removed.
         */
        DanglingUsernameRemoved: PlainDescriptor<Anonymize<Ibdqerrooruuq9>>;
    };
    Utility: {
        /**
         * Batch of dispatches did not complete fully. Index of first failing dispatch given, as
         * well as the error.
         */
        BatchInterrupted: PlainDescriptor<Anonymize<Iflou98pkqhgp1>>;
        /**
         * Batch of dispatches completed fully with no error.
         */
        BatchCompleted: PlainDescriptor<undefined>;
        /**
         * Batch of dispatches completed but has errors.
         */
        BatchCompletedWithErrors: PlainDescriptor<undefined>;
        /**
         * A single item within a Batch of dispatches has completed with no error.
         */
        ItemCompleted: PlainDescriptor<undefined>;
        /**
         * A single item within a Batch of dispatches has completed with error.
         */
        ItemFailed: PlainDescriptor<Anonymize<Ieosut54dhd8pc>>;
        /**
         * A call was dispatched.
         */
        DispatchedAs: PlainDescriptor<Anonymize<Ibguhqka712ouh>>;
    };
    Multisig: {
        /**
         * A new multisig operation has begun.
         */
        NewMultisig: PlainDescriptor<Anonymize<Iep27ialq4a7o7>>;
        /**
         * A multisig operation has been approved by someone.
         */
        MultisigApproval: PlainDescriptor<Anonymize<I9pa9lkcl3m04m>>;
        /**
         * A multisig operation has been executed.
         */
        MultisigExecuted: PlainDescriptor<Anonymize<I1g53hjmqmckm1>>;
        /**
         * A multisig operation has been cancelled.
         */
        MultisigCancelled: PlainDescriptor<Anonymize<Ic9sq0g5877186>>;
    };
    Ethereum: {
        /**
         * An ethereum transaction was successfully executed.
         */
        Executed: PlainDescriptor<Anonymize<Iea4g5ovhnolus>>;
    };
    EVM: {
        /**
         * Ethereum events from contracts.
         */
        Log: PlainDescriptor<Anonymize<Ifmc9boeeia623>>;
        /**
         * A contract has been created at given address.
         */
        Created: PlainDescriptor<Anonymize<Itmchvgqfl28g>>;
        /**
         * A contract was attempted to be created, but the execution failed.
         */
        CreatedFailed: PlainDescriptor<Anonymize<Itmchvgqfl28g>>;
        /**
         * A contract has been executed successfully with states applied.
         */
        Executed: PlainDescriptor<Anonymize<Itmchvgqfl28g>>;
        /**
         * A contract has been executed with errors. States are reverted with only gas fees applied.
         */
        ExecutedFailed: PlainDescriptor<Anonymize<Itmchvgqfl28g>>;
    };
    BaseFee: {
        /**
        
         */
        NewBaseFeePerGas: PlainDescriptor<Anonymize<I7vi74gbubc8u5>>;
        /**
        
         */
        BaseFeeOverflow: PlainDescriptor<undefined>;
        /**
        
         */
        NewElasticity: PlainDescriptor<Anonymize<I3u0knmtb1ueq7>>;
    };
    Proxy: {
        /**
         * A proxy was executed correctly, with the given.
         */
        ProxyExecuted: PlainDescriptor<Anonymize<Ibguhqka712ouh>>;
        /**
         * A pure account has been created by new proxy with given
         * disambiguation index and proxy type.
         */
        PureCreated: PlainDescriptor<Anonymize<Ica53a2fsmlu8g>>;
        /**
         * An announcement was placed to make a call in the future.
         */
        Announced: PlainDescriptor<Anonymize<I2ur0oeqg495j8>>;
        /**
         * A proxy was added.
         */
        ProxyAdded: PlainDescriptor<Anonymize<I71qkr273g0pbg>>;
        /**
         * A proxy was removed.
         */
        ProxyRemoved: PlainDescriptor<Anonymize<I71qkr273g0pbg>>;
    };
    Registration: {
        /**
        
         */
        NodeRegistered: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        MainNodeRegistered: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        NodeUnregistered: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
         * Emitted when multiple nodes are unregistered in a batch
         */
        NodeUnregisteredBatch: PlainDescriptor<Anonymize<Iafscmv8tjf0ou>>;
        /**
        
         */
        NodeStatusUpdated: PlainDescriptor<Anonymize<I95f1d94gdec1o>>;
        /**
         * Fee charging status changed
         */
        FeeChargingStatusChanged: PlainDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
         * Fee percentage changed
         */
        FeePercentageChanged: PlainDescriptor<Anonymize<I9fblj87mudkiv>>;
        /**
         * Node type fee updated
         */
        NodeTypeFeeUpdated: PlainDescriptor<Anonymize<I2oet9jl0tboi4>>;
        /**
        
         */
        NodeTypeDisabledChanged: PlainDescriptor<Anonymize<Icimuh915fen06>>;
        /**
        
         */
        NodeOwnerSwapped: PlainDescriptor<Anonymize<Itdoblp90lfe2>>;
        /**
        
         */
        DeregistrationConsensusReached: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        DeregistrationConsensusFailed: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        AccountBanStatusChanged: PlainDescriptor<Anonymize<I2i9ihlf6tlsua>>;
        /**
        
         */
        WhitelistUpdated: PlainDescriptor<undefined>;
        /**
         * A node was successfully verified
         */
        NodeVerified: PlainDescriptor<Anonymize<I5sa3bg1srbtcp>>;
        /**
         * A coldkey node was successfully verified
         */
        ColdkeyNodeVerified: PlainDescriptor<Anonymize<I5sa3bg1srbtcp>>;
        /**
         * Emitted when the de-registration status is changed
         */
        DeregistrationStatusChanged: PlainDescriptor<Anonymize<I94dejtmu6d72i>>;
    };
    ExecutionUnit: {
        /**
        
         */
        BenchmarkStarted: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        BenchmarkCompleted: PlainDescriptor<Anonymize<Idenpluu9g8b8j>>;
        /**
        
         */
        BenchmarkFailed: PlainDescriptor<Anonymize<Idrt2apfs11eis>>;
        /**
        
         */
        NodeSpecsStored: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        SignedPayloadProcessed: PlainDescriptor<Anonymize<I4q8er4unru0b9>>;
        /**
        
         */
        PinCheckMetricsUpdated: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        PurgeDeregisteredNodesStatusChanged: PlainDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
         * Emitted when storage size is below 2TB.
         */
        StorageBelowTwoTB: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
         * Emitted when primary network interface is not provided.
         */
        NoPrimaryNetworkInterface: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
         * Emitted when disks array is empty.
         */
        EmptyDisksArray: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        MemoryExceedsFiveTB: PlainDescriptor<Anonymize<I6ah8cnfnbkuqo>>;
        /**
        
         */
        ConsensusReached: PlainDescriptor<Anonymize<I8sqgsmt3nkhst>>;
        /**
        
         */
        ConsensusFailed: PlainDescriptor<Anonymize<Iu15sgmdgsi1p>>;
    };
    Metagraph: {
        /**
         * Emitted when hot keys are updated
         */
        HotKeysUpdated: PlainDescriptor<Anonymize<I7v7gll3do8k87>>;
        /**
         * Emitted when a payload is signed and processed
         */
        SignedPayloadProcessed: PlainDescriptor<Anonymize<I4etue4v1vop9d>>;
        /**
         * Emitted when storage is updated
         */
        StorageUpdated: PlainDescriptor<Anonymize<I3p9almsc035kf>>;
        /**
         * Emitted when validator trust points are updated
         */
        ValidatorTrustUpdated: PlainDescriptor<Anonymize<Ic8slrb9jkor44>>;
        /**
         * A validator was added to the whitelist
         */
        WhitelistedValidatorAdded: PlainDescriptor<Anonymize<I9acqruh7322g2>>;
        /**
         * A validator was removed from the whitelist
         */
        WhitelistedValidatorRemoved: PlainDescriptor<Anonymize<I9acqruh7322g2>>;
    };
    Marketplace: {
        /**
         * CDN location added
         */
        CdnLocationAdded: PlainDescriptor<Anonymize<Ic5b47dj4coa3r>>;
        /**
         * Auto-renewal status updated
         */
        AutoRenewalUpdated: PlainDescriptor<Anonymize<I4pplpbc9ri87h>>;
        /**
        
         */
        SubscriptionTransferred: PlainDescriptor<Anonymize<Idfddce516cam8>>;
        /**
        
         */
        TokensBurned: PlainDescriptor<Anonymize<I3qt1hgg4djhgb>>;
        /**
        
         */
        PackageSuspensionSet: PlainDescriptor<Anonymize<I4jk88c81fdpj7>>;
        /**
        
         */
        PinRequested: PlainDescriptor<Anonymize<Iblmvi7rns4hat>>;
        /**
        
         */
        UnpinRequestAdded: PlainDescriptor<Anonymize<I1ncftf0dda44b>>;
        /**
        
         */
        StorageRequestAdded: PlainDescriptor<Anonymize<I4017m8vg7mg77>>;
        /**
        
         */
        StoragePlanPriceUpdated: PlainDescriptor<Anonymize<Ifbfri4ebdp100>>;
        /**
        
         */
        ComputePlanPriceUpdated: PlainDescriptor<Anonymize<Ia0ou717s993mj>>;
        /**
        
         */
        PointTransactionRecorded: PlainDescriptor<Anonymize<I81ecksq9ft26q>>;
        /**
        
         */
        PlanPurchased: PlainDescriptor<Anonymize<Ifg11tc1e56rdc>>;
        /**
        
         */
        FileHashCleanedUp: PlainDescriptor<Anonymize<Ib7rbng5pdr5s8>>;
        /**
        
         */
        PricePerGbUpdated: PlainDescriptor<Anonymize<I6h5nf3idmn898>>;
        /**
        
         */
        PricePerBandwidthUpdated: PlainDescriptor<Anonymize<I6h5nf3idmn898>>;
        /**
        
         */
        StorageSubscriptionCancelled: PlainDescriptor<Anonymize<I4cbvqmqadhrea>>;
        /**
        
         */
        ComputeSubscriptionCancelled: PlainDescriptor<Anonymize<I4cbvqmqadhrea>>;
        /**
        
         */
        BackupEnabled: PlainDescriptor<Anonymize<I3l0mkl2i9jnf2>>;
        /**
        
         */
        BackupDisabled: PlainDescriptor<Anonymize<I3l0mkl2i9jnf2>>;
        /**
        
         */
        OSDiskImageUrlSet: PlainDescriptor<Anonymize<Ibjfehbtn97bsa>>;
        /**
        
         */
        PlanPriceUpdated: PlainDescriptor<Anonymize<I5spuldj7iqfb2>>;
        /**
         * Specific miner request fee updated
         */
        SpecificMinerRequestFeeUpdated: PlainDescriptor<Anonymize<Ib1ilbm5ipoh62>>;
        /**
        
         */
        BatchDeposited: PlainDescriptor<Anonymize<Iercff15akpdf4>>;
        /**
        
         */
        CreditsConsumed: PlainDescriptor<Anonymize<I9vi4snjoo3h4b>>;
        /**
        
         */
        StorageOperationsStatusChanged: PlainDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
         * Purchase plan status was changed
         */
        PurchasePlanStatusChanged: PlainDescriptor<Anonymize<I94dejtmu6d72i>>;
    };
    SubAccount: {
        /**
         * A sub account has been added
         */
        SubAccountAdded: PlainDescriptor<Anonymize<Idsvjrg7b991is>>;
        /**
         * A sub account has been removed
         */
        SubAccountRemoved: PlainDescriptor<Anonymize<Ie4intrc3n8jfu>>;
        /**
         * A sub account's role has been updated
         */
        SubAccountRoleUpdated: PlainDescriptor<Anonymize<I1etdvmasu1v94>>;
    };
    Notifications: {
        /**
         * Notification sent (sender, recipient, block number)
         */
        NotificationSent: PlainDescriptor<Anonymize<Ib6f67cbu0ud37>>;
        /**
         * Notification marked as read (recipient, index)
         */
        NotificationRead: PlainDescriptor<Anonymize<I6ouflveob4eli>>;
        /**
        
         */
        SubscriptionHasEnded: PlainDescriptor<Anonymize<I1kk4k738d2nd8>>;
        /**
        
         */
        SubscriptionEndingSoon: PlainDescriptor<Anonymize<I1kk4k738d2nd8>>;
        /**
        
         */
        AccountBanned: PlainDescriptor<Anonymize<Icbccs0ug47ilf>>;
    };
    AccountProfile: {
        /**
         * A public item was added or updated. [who, item]
         */
        PublicItemSet: PlainDescriptor<Anonymize<I92tce08cbhnmn>>;
        /**
         * A private item was added or updated. [who, item]
         */
        PrivateItemSet: PlainDescriptor<Anonymize<I92tce08cbhnmn>>;
        /**
         * A username was set. [who, username]
         */
        UsernameSet: PlainDescriptor<Anonymize<I92tce08cbhnmn>>;
        /**
        
         */
        DataPublicKeySet: PlainDescriptor<SS58String>;
        /**
         * A message public key was set. [who]
         */
        MessagePublicKeySet: PlainDescriptor<SS58String>;
    };
    RankingStorage: {
        /**
        
         */
        SomethingStored: PlainDescriptor<Anonymize<I2motmr03c9658>>;
        /**
        
         */
        RankingsUpdated: PlainDescriptor<Anonymize<Iafscmv8tjf0ou>>;
        /**
        
         */
        RewardDistributed: PlainDescriptor<Anonymize<Ic262ibdoec56a>>;
        /**
        
         */
        RankDistributionLimitUpdated: PlainDescriptor<Anonymize<I1il5mj68vvsms>>;
    };
    RankingCompute: {
        /**
        
         */
        SomethingStored: PlainDescriptor<Anonymize<I2motmr03c9658>>;
        /**
        
         */
        RankingsUpdated: PlainDescriptor<Anonymize<Iafscmv8tjf0ou>>;
        /**
        
         */
        RewardDistributed: PlainDescriptor<Anonymize<Ic262ibdoec56a>>;
        /**
        
         */
        RankDistributionLimitUpdated: PlainDescriptor<Anonymize<I1il5mj68vvsms>>;
    };
    RankingValidators: {
        /**
        
         */
        SomethingStored: PlainDescriptor<Anonymize<I2motmr03c9658>>;
        /**
        
         */
        RankingsUpdated: PlainDescriptor<Anonymize<Iafscmv8tjf0ou>>;
        /**
        
         */
        RewardDistributed: PlainDescriptor<Anonymize<Ic262ibdoec56a>>;
        /**
        
         */
        RankDistributionLimitUpdated: PlainDescriptor<Anonymize<I1il5mj68vvsms>>;
    };
    Credits: {
        /**
        
         */
        MintedAccountCredits: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
        
         */
        BurnedAccountCredits: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
        
         */
        AuthorityAdded: PlainDescriptor<Anonymize<I4cbvqmqadhrea>>;
        /**
        
         */
        AuthorityRemoved: PlainDescriptor<Anonymize<I4cbvqmqadhrea>>;
        /**
        
         */
        ConvertedToCredits: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
        
         */
        CreditLocked: PlainDescriptor<Anonymize<I88fot44bnslov>>;
        /**
        
         */
        CreditFulfilled: PlainDescriptor<Anonymize<Ieci754e21flil>>;
        /**
        
         */
        AlphaPriceSet: PlainDescriptor<Anonymize<Id7sgl9r2a73an>>;
        /**
        
         */
        MinLockAmountSet: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
         * Event emitted when a referral discount is applied
         */
        ReferralDiscountApplied: PlainDescriptor<Anonymize<I3vte5us4num84>>;
        /**
        
         */
        ConvertedToAlpha: PlainDescriptor<Anonymize<Id5fm4p8lj5qgi>>;
        /**
        
         */
        IncreasedUserBalance: PlainDescriptor<Anonymize<I8vi912pe5tcr7>>;
    };
    ContainerRegistry: {
        /**
         * A new space was created [space_id, owner]
         */
        SpaceCreated: PlainDescriptor<Anonymize<I96rqo4i9p11oo>>;
        /**
         * A member was added to a space [space_id, member]
         */
        MemberAdded: PlainDescriptor<Anonymize<I96rqo4i9p11oo>>;
        /**
         * A manifest digest was updated [repo_name, image_name, tag, digest]
         */
        ManifestDigestUpdated: PlainDescriptor<Anonymize<I7bn9n98cqhjfq>>;
        /**
         * A new mapping of image name + digest to CID was stored
         */
        ImageDigestToCidStored: PlainDescriptor<Anonymize<Ia6h3b4okf7ksl>>;
        /**
         * Digest information successfully stored
         */
        DigestInfoStored: PlainDescriptor<Anonymize<I2pjn1un8imcq7>>;
    };
    AlphaBridge: {
        /**
         * Guardian attested a deposit (vote for success)
         */
        DepositAttested: PlainDescriptor<Anonymize<I1tckflje7cjv>>;
        /**
         * Deposit completed - hAlpha credited to recipient
         */
        DepositCompleted: PlainDescriptor<Anonymize<Ib5s1ffmflb3qm>>;
        /**
         * Deposit cancelled by admin after stuck
         */
        DepositCancelled: PlainDescriptor<Anonymize<I99kjujp4cntp>>;
        /**
         * User created a withdrawal request (hAlpha burned)
         */
        WithdrawalRequestCreated: PlainDescriptor<Anonymize<I4tti5pllg262l>>;
        /**
         * Withdrawal request marked as failed by admin (hAlpha manually minted back)
         */
        WithdrawalRequestFailed: PlainDescriptor<Anonymize<Ifs1i5fk9cqvr6>>;
        /**
         * Admin manually minted hAlpha to a recipient (for stuck withdrawals)
         */
        AdminManualMint: PlainDescriptor<Anonymize<Ifkr43tqovhaij>>;
        /**
         * Bridge paused
         */
        Paused: PlainDescriptor<undefined>;
        /**
         * Bridge unpaused
         */
        Unpaused: PlainDescriptor<undefined>;
        /**
         * Global mint cap updated
         */
        GlobalMintCapUpdated: PlainDescriptor<Anonymize<If0m30u84ipduc>>;
        /**
         * Guardians and threshold updated atomically
         */
        GuardiansUpdated: PlainDescriptor<Anonymize<Iart6p0ogm1a4g>>;
        /**
         * Minimum withdrawal amount updated
         */
        MinWithdrawalAmountUpdated: PlainDescriptor<Anonymize<If8q631vdal219>>;
        /**
         * Deposit record cleaned up after TTL
         */
        DepositCleanedUp: PlainDescriptor<Anonymize<Ifs1i5fk9cqvr6>>;
        /**
         * Withdrawal request record cleaned up after TTL
         */
        WithdrawalRequestCleanedUp: PlainDescriptor<Anonymize<Ifs1i5fk9cqvr6>>;
        /**
         * Cleanup TTL updated
         */
        CleanupTTLUpdated: PlainDescriptor<Anonymize<Iaqm07nd3jnjm3>>;
    };
    PalletIp: {
        /**
        
         */
        IpAssigned: PlainDescriptor<Anonymize<I91984ic727015>>;
        /**
        
         */
        IpReturned: PlainDescriptor<Anonymize<I38bt9hnqlio44>>;
        /**
        
         */
        IpRetrieved: PlainDescriptor<Anonymize<I38bt9hnqlio44>>;
        /**
        
         */
        IpAdded: PlainDescriptor<Anonymize<I91984ic727015>>;
        /**
        
         */
        IpRemoved: PlainDescriptor<Anonymize<I91984ic727015>>;
    };
    IpfsPallet: {
        /**
        
         */
        SomethingStored: PlainDescriptor<Anonymize<I2motmr03c9658>>;
        /**
        
         */
        StorageRequestUpdated: PlainDescriptor<Anonymize<I1udjuelukvhag>>;
        /**
        
         */
        UnpinRequestCompleted: PlainDescriptor<Anonymize<I1udjuelukvhag>>;
        /**
        
         */
        PinningEnabledChanged: PlainDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
        
         */
        MinerProfilesUpdated: PlainDescriptor<Anonymize<I1lhs3d4ekov9p>>;
        /**
        
         */
        StorageRequestsCleared: PlainDescriptor<undefined>;
        /**
        
         */
        ReputationPointsUpdated: PlainDescriptor<Anonymize<Ia2msbpam1cji1>>;
        /**
        
         */
        RotationStatusChanged: PlainDescriptor<boolean>;
        /**
         * A user's storage request was removed due to IPFS unavailability
         */
        IpfsUnavailable: PlainDescriptor<Anonymize<I7ckaemrn32ju>>;
        /**
        
         */
        UserProfileUpdated: PlainDescriptor<Anonymize<Idu6bl8365ot38>>;
        /**
        
         */
        UsersProfilesUpdated: PlainDescriptor<undefined>;
        /**
        
         */
        MinersProfilesUpdated: PlainDescriptor<undefined>;
        /**
        
         */
        MinerProfileUpdated: PlainDescriptor<Anonymize<I2k4l82jgghpug>>;
        /**
         * Emitted when validator is rotated at the beginning of a new epoch.
         */
        ValidatorRotated: PlainDescriptor<Anonymize<Ic6k2eeen6ajgt>>;
        /**
         * Emitted when storage requests are closed by the validator
         */
        StorageRequestsClosed: PlainDescriptor<Anonymize<I8ri442nsb40lv>>;
        /**
         * Emitted when unpin requests are closed by the validator
         */
        UnpinRequestsClosed: PlainDescriptor<Anonymize<I8ri442nsb40lv>>;
    };
    Arion: {
        /**
         * A new CRUSH epoch was published.
         */
        CrushMapPublished: PlainDescriptor<Anonymize<Ibnl9iu19ttf33>>;
        /**
         * Miner stats were updated for a bucket.
         */
        MinerStatsUpdated: PlainDescriptor<Anonymize<I3btqr02g3j6t5>>;
        /**
         * Attestations were submitted for a bucket.
         */
        AttestationsSubmitted: PlainDescriptor<Anonymize<I60f9q2drfiblu>>;
        /**
         * Attestation commitment was submitted for an epoch.
         */
        AttestationCommitmentSubmitted: PlainDescriptor<Anonymize<Idb9q16jbip9cv>>;
        /**
         * A child node was registered under a family.
         */
        ChildRegistered: PlainDescriptor<Anonymize<Id7emp2djki762>>;
        /**
         * A child node was deregistered and entered unbonding.
         */
        ChildDeregistered: PlainDescriptor<Anonymize<Idff3go57k37mm>>;
        /**
         * A child’s deposit was unbonded and released.
         */
        ChildUnbonded: PlainDescriptor<Anonymize<Ie4guudbjqttqv>>;
        /**
         * Node weights were updated for a bucket.
         */
        NodeWeightsUpdated: PlainDescriptor<Anonymize<I3btqr02g3j6t5>>;
        /**
         * Family weights were recomputed for a bucket.
         */
        FamilyWeightsComputed: PlainDescriptor<Anonymize<I7uk77lejof7mb>>;
        /**
         * Registration lockup was enabled/disabled by admin.
         */
        LockupEnabledSet: PlainDescriptor<Anonymize<I94dejtmu6d72i>>;
        /**
         * Base child deposit floor was set by admin.
         */
        BaseChildDepositSet: PlainDescriptor<Anonymize<I1fm7b684mo0pb>>;
        /**
         * A warden was registered and authorized to submit attestations.
         */
        WardenRegistered: PlainDescriptor<Anonymize<Idftouvduud2qb>>;
        /**
         * A warden was deregistered and can no longer submit attestations.
         */
        WardenDeregistered: PlainDescriptor<Anonymize<Ifsg9bn8i41e00>>;
        /**
         * Old attestation buckets were pruned.
         */
        AttestationBucketsPruned: PlainDescriptor<Anonymize<I4u87dkg0ej74m>>;
    };
};
type IError = {
    System: {
        /**
         * The name of specification does not match between the current runtime
         * and the new runtime.
         */
        InvalidSpecName: PlainDescriptor<undefined>;
        /**
         * The specification version is not allowed to decrease between the current runtime
         * and the new runtime.
         */
        SpecVersionNeedsToIncrease: PlainDescriptor<undefined>;
        /**
         * Failed to extract the runtime version from the new runtime.
         *
         * Either calling `Core_version` or decoding `RuntimeVersion` failed.
         */
        FailedToExtractRuntimeVersion: PlainDescriptor<undefined>;
        /**
         * Suicide called when the account has non-default composite data.
         */
        NonDefaultComposite: PlainDescriptor<undefined>;
        /**
         * There is a non-zero reference count preventing the account from being purged.
         */
        NonZeroRefCount: PlainDescriptor<undefined>;
        /**
         * The origin filter prevent the call to be dispatched.
         */
        CallFiltered: PlainDescriptor<undefined>;
        /**
         * A multi-block migration is ongoing and prevents the current code from being replaced.
         */
        MultiBlockMigrationsOngoing: PlainDescriptor<undefined>;
        /**
         * No upgrade authorized.
         */
        NothingAuthorized: PlainDescriptor<undefined>;
        /**
         * The submitted code is not authorized.
         */
        Unauthorized: PlainDescriptor<undefined>;
    };
    Sudo: {
        /**
         * Sender must be the Sudo account.
         */
        RequireSudo: PlainDescriptor<undefined>;
    };
    Assets: {
        /**
         * Account balance must be greater than or equal to the transfer amount.
         */
        BalanceLow: PlainDescriptor<undefined>;
        /**
         * The account to alter does not exist.
         */
        NoAccount: PlainDescriptor<undefined>;
        /**
         * The signing account has no permission to do the operation.
         */
        NoPermission: PlainDescriptor<undefined>;
        /**
         * The given asset ID is unknown.
         */
        Unknown: PlainDescriptor<undefined>;
        /**
         * The origin account is frozen.
         */
        Frozen: PlainDescriptor<undefined>;
        /**
         * The asset ID is already taken.
         */
        InUse: PlainDescriptor<undefined>;
        /**
         * Invalid witness data given.
         */
        BadWitness: PlainDescriptor<undefined>;
        /**
         * Minimum balance should be non-zero.
         */
        MinBalanceZero: PlainDescriptor<undefined>;
        /**
         * Unable to increment the consumer reference counters on the account. Either no provider
         * reference exists to allow a non-zero balance of a non-self-sufficient asset, or one
         * fewer then the maximum number of consumers has been reached.
         */
        UnavailableConsumer: PlainDescriptor<undefined>;
        /**
         * Invalid metadata given.
         */
        BadMetadata: PlainDescriptor<undefined>;
        /**
         * No approval exists that would allow the transfer.
         */
        Unapproved: PlainDescriptor<undefined>;
        /**
         * The source account would not survive the transfer and it needs to stay alive.
         */
        WouldDie: PlainDescriptor<undefined>;
        /**
         * The asset-account already exists.
         */
        AlreadyExists: PlainDescriptor<undefined>;
        /**
         * The asset-account doesn't have an associated deposit.
         */
        NoDeposit: PlainDescriptor<undefined>;
        /**
         * The operation would result in funds being burned.
         */
        WouldBurn: PlainDescriptor<undefined>;
        /**
         * The asset is a live asset and is actively being used. Usually emit for operations such
         * as `start_destroy` which require the asset to be in a destroying state.
         */
        LiveAsset: PlainDescriptor<undefined>;
        /**
         * The asset is not live, and likely being destroyed.
         */
        AssetNotLive: PlainDescriptor<undefined>;
        /**
         * The asset status is not the expected status.
         */
        IncorrectStatus: PlainDescriptor<undefined>;
        /**
         * The asset should be frozen before the given operation.
         */
        NotFrozen: PlainDescriptor<undefined>;
        /**
         * Callback action resulted in error
         */
        CallbackFailed: PlainDescriptor<undefined>;
        /**
         * The asset ID must be equal to the [`NextAssetId`].
         */
        BadAssetId: PlainDescriptor<undefined>;
    };
    Balances: {
        /**
         * Vesting balance too high to send value.
         */
        VestingBalance: PlainDescriptor<undefined>;
        /**
         * Account liquidity restrictions prevent withdrawal.
         */
        LiquidityRestrictions: PlainDescriptor<undefined>;
        /**
         * Balance too low to send value.
         */
        InsufficientBalance: PlainDescriptor<undefined>;
        /**
         * Value too low to create account due to existential deposit.
         */
        ExistentialDeposit: PlainDescriptor<undefined>;
        /**
         * Transfer/payment would kill account.
         */
        Expendability: PlainDescriptor<undefined>;
        /**
         * A vesting schedule already exists for this account.
         */
        ExistingVestingSchedule: PlainDescriptor<undefined>;
        /**
         * Beneficiary account must pre-exist.
         */
        DeadAccount: PlainDescriptor<undefined>;
        /**
         * Number of named reserves exceed `MaxReserves`.
         */
        TooManyReserves: PlainDescriptor<undefined>;
        /**
         * Number of holds exceed `VariantCountOf<T::RuntimeHoldReason>`.
         */
        TooManyHolds: PlainDescriptor<undefined>;
        /**
         * Number of freezes exceed `MaxFreezes`.
         */
        TooManyFreezes: PlainDescriptor<undefined>;
        /**
         * The issuance cannot be modified since it is already deactivated.
         */
        IssuanceDeactivated: PlainDescriptor<undefined>;
        /**
         * The delta cannot be zero.
         */
        DeltaZero: PlainDescriptor<undefined>;
    };
    Babe: {
        /**
         * An equivocation proof provided as part of an equivocation report is invalid.
         */
        InvalidEquivocationProof: PlainDescriptor<undefined>;
        /**
         * A key ownership proof provided as part of an equivocation report is invalid.
         */
        InvalidKeyOwnershipProof: PlainDescriptor<undefined>;
        /**
         * A given equivocation report is valid but already previously reported.
         */
        DuplicateOffenceReport: PlainDescriptor<undefined>;
        /**
         * Submitted configuration is invalid.
         */
        InvalidConfiguration: PlainDescriptor<undefined>;
    };
    Grandpa: {
        /**
         * Attempt to signal GRANDPA pause when the authority set isn't live
         * (either paused or already pending pause).
         */
        PauseFailed: PlainDescriptor<undefined>;
        /**
         * Attempt to signal GRANDPA resume when the authority set isn't paused
         * (either live or already pending resume).
         */
        ResumeFailed: PlainDescriptor<undefined>;
        /**
         * Attempt to signal GRANDPA change with one already pending.
         */
        ChangePending: PlainDescriptor<undefined>;
        /**
         * Cannot signal forced change so soon after last.
         */
        TooSoon: PlainDescriptor<undefined>;
        /**
         * A key ownership proof provided as part of an equivocation report is invalid.
         */
        InvalidKeyOwnershipProof: PlainDescriptor<undefined>;
        /**
         * An equivocation proof provided as part of an equivocation report is invalid.
         */
        InvalidEquivocationProof: PlainDescriptor<undefined>;
        /**
         * A given equivocation report is valid but already previously reported.
         */
        DuplicateOffenceReport: PlainDescriptor<undefined>;
    };
    Indices: {
        /**
         * The index was not already assigned.
         */
        NotAssigned: PlainDescriptor<undefined>;
        /**
         * The index is assigned to another account.
         */
        NotOwner: PlainDescriptor<undefined>;
        /**
         * The index was not available.
         */
        InUse: PlainDescriptor<undefined>;
        /**
         * The source and destination accounts are identical.
         */
        NotTransfer: PlainDescriptor<undefined>;
        /**
         * The index is permanent and may not be freed/changed.
         */
        Permanent: PlainDescriptor<undefined>;
    };
    Democracy: {
        /**
         * Value too low
         */
        ValueLow: PlainDescriptor<undefined>;
        /**
         * Proposal does not exist
         */
        ProposalMissing: PlainDescriptor<undefined>;
        /**
         * Cannot cancel the same proposal twice
         */
        AlreadyCanceled: PlainDescriptor<undefined>;
        /**
         * Proposal already made
         */
        DuplicateProposal: PlainDescriptor<undefined>;
        /**
         * Proposal still blacklisted
         */
        ProposalBlacklisted: PlainDescriptor<undefined>;
        /**
         * Next external proposal not simple majority
         */
        NotSimpleMajority: PlainDescriptor<undefined>;
        /**
         * Invalid hash
         */
        InvalidHash: PlainDescriptor<undefined>;
        /**
         * No external proposal
         */
        NoProposal: PlainDescriptor<undefined>;
        /**
         * Identity may not veto a proposal twice
         */
        AlreadyVetoed: PlainDescriptor<undefined>;
        /**
         * Vote given for invalid referendum
         */
        ReferendumInvalid: PlainDescriptor<undefined>;
        /**
         * No proposals waiting
         */
        NoneWaiting: PlainDescriptor<undefined>;
        /**
         * The given account did not vote on the referendum.
         */
        NotVoter: PlainDescriptor<undefined>;
        /**
         * The actor has no permission to conduct the action.
         */
        NoPermission: PlainDescriptor<undefined>;
        /**
         * The account is already delegating.
         */
        AlreadyDelegating: PlainDescriptor<undefined>;
        /**
         * Too high a balance was provided that the account cannot afford.
         */
        InsufficientFunds: PlainDescriptor<undefined>;
        /**
         * The account is not currently delegating.
         */
        NotDelegating: PlainDescriptor<undefined>;
        /**
         * The account currently has votes attached to it and the operation cannot succeed until
         * these are removed, either through `unvote` or `reap_vote`.
         */
        VotesExist: PlainDescriptor<undefined>;
        /**
         * The instant referendum origin is currently disallowed.
         */
        InstantNotAllowed: PlainDescriptor<undefined>;
        /**
         * Delegation to oneself makes no sense.
         */
        Nonsense: PlainDescriptor<undefined>;
        /**
         * Invalid upper bound.
         */
        WrongUpperBound: PlainDescriptor<undefined>;
        /**
         * Maximum number of votes reached.
         */
        MaxVotesReached: PlainDescriptor<undefined>;
        /**
         * Maximum number of items reached.
         */
        TooMany: PlainDescriptor<undefined>;
        /**
         * Voting period too low
         */
        VotingPeriodLow: PlainDescriptor<undefined>;
        /**
         * The preimage does not exist.
         */
        PreimageNotExist: PlainDescriptor<undefined>;
    };
    Council: {
        /**
         * Account is not a member
         */
        NotMember: PlainDescriptor<undefined>;
        /**
         * Duplicate proposals not allowed
         */
        DuplicateProposal: PlainDescriptor<undefined>;
        /**
         * Proposal must exist
         */
        ProposalMissing: PlainDescriptor<undefined>;
        /**
         * Mismatched index
         */
        WrongIndex: PlainDescriptor<undefined>;
        /**
         * Duplicate vote ignored
         */
        DuplicateVote: PlainDescriptor<undefined>;
        /**
         * Members are already initialized!
         */
        AlreadyInitialized: PlainDescriptor<undefined>;
        /**
         * The close call was made too early, before the end of the voting.
         */
        TooEarly: PlainDescriptor<undefined>;
        /**
         * There can only be a maximum of `MaxProposals` active proposals.
         */
        TooManyProposals: PlainDescriptor<undefined>;
        /**
         * The given weight bound for the proposal was too low.
         */
        WrongProposalWeight: PlainDescriptor<undefined>;
        /**
         * The given length bound for the proposal was too low.
         */
        WrongProposalLength: PlainDescriptor<undefined>;
        /**
         * Prime account is not a member
         */
        PrimeAccountNotMember: PlainDescriptor<undefined>;
    };
    Vesting: {
        /**
         * The account given is not vesting.
         */
        NotVesting: PlainDescriptor<undefined>;
        /**
         * The account already has `MaxVestingSchedules` count of schedules and thus
         * cannot add another one. Consider merging existing schedules in order to add another.
         */
        AtMaxVestingSchedules: PlainDescriptor<undefined>;
        /**
         * Amount being transferred is too low to create a vesting schedule.
         */
        AmountLow: PlainDescriptor<undefined>;
        /**
         * An index was out of bounds of the vesting schedules.
         */
        ScheduleIndexOutOfBounds: PlainDescriptor<undefined>;
        /**
         * Failed to create a new schedule because some parameter was invalid.
         */
        InvalidScheduleParams: PlainDescriptor<undefined>;
    };
    Elections: {
        /**
         * Cannot vote when no candidates or members exist.
         */
        UnableToVote: PlainDescriptor<undefined>;
        /**
         * Must vote for at least one candidate.
         */
        NoVotes: PlainDescriptor<undefined>;
        /**
         * Cannot vote more than candidates.
         */
        TooManyVotes: PlainDescriptor<undefined>;
        /**
         * Cannot vote more than maximum allowed.
         */
        MaximumVotesExceeded: PlainDescriptor<undefined>;
        /**
         * Cannot vote with stake less than minimum balance.
         */
        LowBalance: PlainDescriptor<undefined>;
        /**
         * Voter can not pay voting bond.
         */
        UnableToPayBond: PlainDescriptor<undefined>;
        /**
         * Must be a voter.
         */
        MustBeVoter: PlainDescriptor<undefined>;
        /**
         * Duplicated candidate submission.
         */
        DuplicatedCandidate: PlainDescriptor<undefined>;
        /**
         * Too many candidates have been created.
         */
        TooManyCandidates: PlainDescriptor<undefined>;
        /**
         * Member cannot re-submit candidacy.
         */
        MemberSubmit: PlainDescriptor<undefined>;
        /**
         * Runner cannot re-submit candidacy.
         */
        RunnerUpSubmit: PlainDescriptor<undefined>;
        /**
         * Candidate does not have enough funds.
         */
        InsufficientCandidateFunds: PlainDescriptor<undefined>;
        /**
         * Not a member.
         */
        NotMember: PlainDescriptor<undefined>;
        /**
         * The provided count of number of candidates is incorrect.
         */
        InvalidWitnessData: PlainDescriptor<undefined>;
        /**
         * The provided count of number of votes is incorrect.
         */
        InvalidVoteCount: PlainDescriptor<undefined>;
        /**
         * The renouncing origin presented a wrong `Renouncing` parameter.
         */
        InvalidRenouncing: PlainDescriptor<undefined>;
        /**
         * Prediction regarding replacement after member removal is wrong.
         */
        InvalidReplacement: PlainDescriptor<undefined>;
    };
    ElectionProviderMultiPhase: {
        /**
         * Submission was too early.
         */
        PreDispatchEarlySubmission: PlainDescriptor<undefined>;
        /**
         * Wrong number of winners presented.
         */
        PreDispatchWrongWinnerCount: PlainDescriptor<undefined>;
        /**
         * Submission was too weak, score-wise.
         */
        PreDispatchWeakSubmission: PlainDescriptor<undefined>;
        /**
         * The queue was full, and the solution was not better than any of the existing ones.
         */
        SignedQueueFull: PlainDescriptor<undefined>;
        /**
         * The origin failed to pay the deposit.
         */
        SignedCannotPayDeposit: PlainDescriptor<undefined>;
        /**
         * Witness data to dispatchable is invalid.
         */
        SignedInvalidWitness: PlainDescriptor<undefined>;
        /**
         * The signed submission consumes too much weight
         */
        SignedTooMuchWeight: PlainDescriptor<undefined>;
        /**
         * OCW submitted solution for wrong round
         */
        OcwCallWrongEra: PlainDescriptor<undefined>;
        /**
         * Snapshot metadata should exist but didn't.
         */
        MissingSnapshotMetadata: PlainDescriptor<undefined>;
        /**
         * `Self::insert_submission` returned an invalid index.
         */
        InvalidSubmissionIndex: PlainDescriptor<undefined>;
        /**
         * The call is not allowed at this point.
         */
        CallNotAllowed: PlainDescriptor<undefined>;
        /**
         * The fallback failed
         */
        FallbackFailed: PlainDescriptor<undefined>;
        /**
         * Some bound not met
         */
        BoundNotMet: PlainDescriptor<undefined>;
        /**
         * Submitted solution has too many winners
         */
        TooManyWinners: PlainDescriptor<undefined>;
        /**
         * Submission was prepared for a different round.
         */
        PreDispatchDifferentRound: PlainDescriptor<undefined>;
    };
    Staking: {
        /**
         * Not a controller account.
         */
        NotController: PlainDescriptor<undefined>;
        /**
         * Not a stash account.
         */
        NotStash: PlainDescriptor<undefined>;
        /**
         * Stash is already bonded.
         */
        AlreadyBonded: PlainDescriptor<undefined>;
        /**
         * Controller is already paired.
         */
        AlreadyPaired: PlainDescriptor<undefined>;
        /**
         * Targets cannot be empty.
         */
        EmptyTargets: PlainDescriptor<undefined>;
        /**
         * Duplicate index.
         */
        DuplicateIndex: PlainDescriptor<undefined>;
        /**
         * Slash record index out of bounds.
         */
        InvalidSlashIndex: PlainDescriptor<undefined>;
        /**
         * Cannot have a validator or nominator role, with value less than the minimum defined by
         * governance (see `MinValidatorBond` and `MinNominatorBond`). If unbonding is the
         * intention, `chill` first to remove one's role as validator/nominator.
         */
        InsufficientBond: PlainDescriptor<undefined>;
        /**
         * Can not schedule more unlock chunks.
         */
        NoMoreChunks: PlainDescriptor<undefined>;
        /**
         * Can not rebond without unlocking chunks.
         */
        NoUnlockChunk: PlainDescriptor<undefined>;
        /**
         * Attempting to target a stash that still has funds.
         */
        FundedTarget: PlainDescriptor<undefined>;
        /**
         * Invalid era to reward.
         */
        InvalidEraToReward: PlainDescriptor<undefined>;
        /**
         * Invalid number of nominations.
         */
        InvalidNumberOfNominations: PlainDescriptor<undefined>;
        /**
         * Items are not sorted and unique.
         */
        NotSortedAndUnique: PlainDescriptor<undefined>;
        /**
         * Rewards for this era have already been claimed for this validator.
         */
        AlreadyClaimed: PlainDescriptor<undefined>;
        /**
         * No nominators exist on this page.
         */
        InvalidPage: PlainDescriptor<undefined>;
        /**
         * Incorrect previous history depth input provided.
         */
        IncorrectHistoryDepth: PlainDescriptor<undefined>;
        /**
         * Incorrect number of slashing spans provided.
         */
        IncorrectSlashingSpans: PlainDescriptor<undefined>;
        /**
         * Internal state has become somehow corrupted and the operation cannot continue.
         */
        BadState: PlainDescriptor<undefined>;
        /**
         * Too many nomination targets supplied.
         */
        TooManyTargets: PlainDescriptor<undefined>;
        /**
         * A nomination target was supplied that was blocked or otherwise not a validator.
         */
        BadTarget: PlainDescriptor<undefined>;
        /**
         * The user has enough bond and thus cannot be chilled forcefully by an external person.
         */
        CannotChillOther: PlainDescriptor<undefined>;
        /**
         * There are too many nominators in the system. Governance needs to adjust the staking
         * settings to keep things safe for the runtime.
         */
        TooManyNominators: PlainDescriptor<undefined>;
        /**
         * There are too many validator candidates in the system. Governance needs to adjust the
         * staking settings to keep things safe for the runtime.
         */
        TooManyValidators: PlainDescriptor<undefined>;
        /**
         * Commission is too low. Must be at least `MinCommission`.
         */
        CommissionTooLow: PlainDescriptor<undefined>;
        /**
         * Some bound is not met.
         */
        BoundNotMet: PlainDescriptor<undefined>;
        /**
         * Used when attempting to use deprecated controller account logic.
         */
        ControllerDeprecated: PlainDescriptor<undefined>;
        /**
         * Cannot reset a ledger.
         */
        CannotRestoreLedger: PlainDescriptor<undefined>;
        /**
         * Provided reward destination is not allowed.
         */
        RewardDestinationRestricted: PlainDescriptor<undefined>;
        /**
         * Not enough funds available to withdraw.
         */
        NotEnoughFunds: PlainDescriptor<undefined>;
        /**
         * Operation not allowed for virtual stakers.
         */
        VirtualStakerNotAllowed: PlainDescriptor<undefined>;
    };
    Session: {
        /**
         * Invalid ownership proof.
         */
        InvalidProof: PlainDescriptor<undefined>;
        /**
         * No associated validator ID for account.
         */
        NoAssociatedValidatorId: PlainDescriptor<undefined>;
        /**
         * Registered duplicate key.
         */
        DuplicatedKey: PlainDescriptor<undefined>;
        /**
         * No keys are associated with this account.
         */
        NoKeys: PlainDescriptor<undefined>;
        /**
         * Key setting account is not live, so it's impossible to associate keys.
         */
        NoAccount: PlainDescriptor<undefined>;
    };
    Treasury: {
        /**
         * No proposal, bounty or spend at that index.
         */
        InvalidIndex: PlainDescriptor<undefined>;
        /**
         * Too many approvals in the queue.
         */
        TooManyApprovals: PlainDescriptor<undefined>;
        /**
         * The spend origin is valid but the amount it is allowed to spend is lower than the
         * amount to be spent.
         */
        InsufficientPermission: PlainDescriptor<undefined>;
        /**
         * Proposal has not been approved.
         */
        ProposalNotApproved: PlainDescriptor<undefined>;
        /**
         * The balance of the asset kind is not convertible to the balance of the native asset.
         */
        FailedToConvertBalance: PlainDescriptor<undefined>;
        /**
         * The spend has expired and cannot be claimed.
         */
        SpendExpired: PlainDescriptor<undefined>;
        /**
         * The spend is not yet eligible for payout.
         */
        EarlyPayout: PlainDescriptor<undefined>;
        /**
         * The payment has already been attempted.
         */
        AlreadyAttempted: PlainDescriptor<undefined>;
        /**
         * There was some issue with the mechanism of payment.
         */
        PayoutError: PlainDescriptor<undefined>;
        /**
         * The payout was not yet attempted/claimed.
         */
        NotAttempted: PlainDescriptor<undefined>;
        /**
         * The payment has neither failed nor succeeded yet.
         */
        Inconclusive: PlainDescriptor<undefined>;
    };
    Bounties: {
        /**
         * Proposer's balance is too low.
         */
        InsufficientProposersBalance: PlainDescriptor<undefined>;
        /**
         * No proposal or bounty at that index.
         */
        InvalidIndex: PlainDescriptor<undefined>;
        /**
         * The reason given is just too big.
         */
        ReasonTooBig: PlainDescriptor<undefined>;
        /**
         * The bounty status is unexpected.
         */
        UnexpectedStatus: PlainDescriptor<undefined>;
        /**
         * Require bounty curator.
         */
        RequireCurator: PlainDescriptor<undefined>;
        /**
         * Invalid bounty value.
         */
        InvalidValue: PlainDescriptor<undefined>;
        /**
         * Invalid bounty fee.
         */
        InvalidFee: PlainDescriptor<undefined>;
        /**
         * A bounty payout is pending.
         * To cancel the bounty, you must unassign and slash the curator.
         */
        PendingPayout: PlainDescriptor<undefined>;
        /**
         * The bounties cannot be claimed/closed because it's still in the countdown period.
         */
        Premature: PlainDescriptor<undefined>;
        /**
         * The bounty cannot be closed because it has active child bounties.
         */
        HasActiveChildBounty: PlainDescriptor<undefined>;
        /**
         * Too many approvals are already queued.
         */
        TooManyQueued: PlainDescriptor<undefined>;
    };
    ChildBounties: {
        /**
         * The parent bounty is not in active state.
         */
        ParentBountyNotActive: PlainDescriptor<undefined>;
        /**
         * The bounty balance is not enough to add new child-bounty.
         */
        InsufficientBountyBalance: PlainDescriptor<undefined>;
        /**
         * Number of child bounties exceeds limit `MaxActiveChildBountyCount`.
         */
        TooManyChildBounties: PlainDescriptor<undefined>;
    };
    BagsList: {
        /**
         * A error in the list interface implementation.
         */
        List: PlainDescriptor<BagsListListListError>;
    };
    NominationPools: {
        /**
         * A (bonded) pool id does not exist.
         */
        PoolNotFound: PlainDescriptor<undefined>;
        /**
         * An account is not a member.
         */
        PoolMemberNotFound: PlainDescriptor<undefined>;
        /**
         * A reward pool does not exist. In all cases this is a system logic error.
         */
        RewardPoolNotFound: PlainDescriptor<undefined>;
        /**
         * A sub pool does not exist.
         */
        SubPoolsNotFound: PlainDescriptor<undefined>;
        /**
         * An account is already delegating in another pool. An account may only belong to one
         * pool at a time.
         */
        AccountBelongsToOtherPool: PlainDescriptor<undefined>;
        /**
         * The member is fully unbonded (and thus cannot access the bonded and reward pool
         * anymore to, for example, collect rewards).
         */
        FullyUnbonding: PlainDescriptor<undefined>;
        /**
         * The member cannot unbond further chunks due to reaching the limit.
         */
        MaxUnbondingLimit: PlainDescriptor<undefined>;
        /**
         * None of the funds can be withdrawn yet because the bonding duration has not passed.
         */
        CannotWithdrawAny: PlainDescriptor<undefined>;
        /**
         * The amount does not meet the minimum bond to either join or create a pool.
         *
         * The depositor can never unbond to a value less than `Pallet::depositor_min_bond`. The
         * caller does not have nominating permissions for the pool. Members can never unbond to a
         * value below `MinJoinBond`.
         */
        MinimumBondNotMet: PlainDescriptor<undefined>;
        /**
         * The transaction could not be executed due to overflow risk for the pool.
         */
        OverflowRisk: PlainDescriptor<undefined>;
        /**
         * A pool must be in [`PoolState::Destroying`] in order for the depositor to unbond or for
         * other members to be permissionlessly unbonded.
         */
        NotDestroying: PlainDescriptor<undefined>;
        /**
         * The caller does not have nominating permissions for the pool.
         */
        NotNominator: PlainDescriptor<undefined>;
        /**
         * Either a) the caller cannot make a valid kick or b) the pool is not destroying.
         */
        NotKickerOrDestroying: PlainDescriptor<undefined>;
        /**
         * The pool is not open to join
         */
        NotOpen: PlainDescriptor<undefined>;
        /**
         * The system is maxed out on pools.
         */
        MaxPools: PlainDescriptor<undefined>;
        /**
         * Too many members in the pool or system.
         */
        MaxPoolMembers: PlainDescriptor<undefined>;
        /**
         * The pools state cannot be changed.
         */
        CanNotChangeState: PlainDescriptor<undefined>;
        /**
         * The caller does not have adequate permissions.
         */
        DoesNotHavePermission: PlainDescriptor<undefined>;
        /**
         * Metadata exceeds [`Config::MaxMetadataLen`]
         */
        MetadataExceedsMaxLen: PlainDescriptor<undefined>;
        /**
         * Some error occurred that should never happen. This should be reported to the
         * maintainers.
         */
        Defensive: PlainDescriptor<Anonymize<Ie2db4l6126rkt>>;
        /**
         * Partial unbonding now allowed permissionlessly.
         */
        PartialUnbondNotAllowedPermissionlessly: PlainDescriptor<undefined>;
        /**
         * The pool's max commission cannot be set higher than the existing value.
         */
        MaxCommissionRestricted: PlainDescriptor<undefined>;
        /**
         * The supplied commission exceeds the max allowed commission.
         */
        CommissionExceedsMaximum: PlainDescriptor<undefined>;
        /**
         * The supplied commission exceeds global maximum commission.
         */
        CommissionExceedsGlobalMaximum: PlainDescriptor<undefined>;
        /**
         * Not enough blocks have surpassed since the last commission update.
         */
        CommissionChangeThrottled: PlainDescriptor<undefined>;
        /**
         * The submitted changes to commission change rate are not allowed.
         */
        CommissionChangeRateNotAllowed: PlainDescriptor<undefined>;
        /**
         * There is no pending commission to claim.
         */
        NoPendingCommission: PlainDescriptor<undefined>;
        /**
         * No commission current has been set.
         */
        NoCommissionCurrentSet: PlainDescriptor<undefined>;
        /**
         * Pool id currently in use.
         */
        PoolIdInUse: PlainDescriptor<undefined>;
        /**
         * Pool id provided is not correct/usable.
         */
        InvalidPoolId: PlainDescriptor<undefined>;
        /**
         * Bonding extra is restricted to the exact pending reward amount.
         */
        BondExtraRestricted: PlainDescriptor<undefined>;
        /**
         * No imbalance in the ED deposit for the pool.
         */
        NothingToAdjust: PlainDescriptor<undefined>;
        /**
         * No slash pending that can be applied to the member.
         */
        NothingToSlash: PlainDescriptor<undefined>;
        /**
         * The slash amount is too low to be applied.
         */
        SlashTooLow: PlainDescriptor<undefined>;
        /**
         * The pool or member delegation has already migrated to delegate stake.
         */
        AlreadyMigrated: PlainDescriptor<undefined>;
        /**
         * The pool or member delegation has not migrated yet to delegate stake.
         */
        NotMigrated: PlainDescriptor<undefined>;
        /**
         * This call is not allowed in the current state of the pallet.
         */
        NotSupported: PlainDescriptor<undefined>;
    };
    Scheduler: {
        /**
         * Failed to schedule a call
         */
        FailedToSchedule: PlainDescriptor<undefined>;
        /**
         * Cannot find the scheduled call.
         */
        NotFound: PlainDescriptor<undefined>;
        /**
         * Given target block number is in the past.
         */
        TargetBlockNumberInPast: PlainDescriptor<undefined>;
        /**
         * Reschedule failed because it does not change scheduled time.
         */
        RescheduleNoChange: PlainDescriptor<undefined>;
        /**
         * Attempt to use a non-named function on a named task.
         */
        Named: PlainDescriptor<undefined>;
    };
    Preimage: {
        /**
         * Preimage is too large to store on-chain.
         */
        TooBig: PlainDescriptor<undefined>;
        /**
         * Preimage has already been noted on-chain.
         */
        AlreadyNoted: PlainDescriptor<undefined>;
        /**
         * The user is not authorized to perform this action.
         */
        NotAuthorized: PlainDescriptor<undefined>;
        /**
         * The preimage cannot be removed since it has not yet been noted.
         */
        NotNoted: PlainDescriptor<undefined>;
        /**
         * A preimage may not be removed when there are outstanding requests.
         */
        Requested: PlainDescriptor<undefined>;
        /**
         * The preimage request cannot be removed since no outstanding requests exist.
         */
        NotRequested: PlainDescriptor<undefined>;
        /**
         * More than `MAX_HASH_UPGRADE_BULK_COUNT` hashes were requested to be upgraded at once.
         */
        TooMany: PlainDescriptor<undefined>;
        /**
         * Too few hashes were requested to be upgraded (i.e. zero).
         */
        TooFew: PlainDescriptor<undefined>;
        /**
         * No ticket with a cost was returned by [`Config::Consideration`] to store the preimage.
         */
        NoCost: PlainDescriptor<undefined>;
    };
    TxPause: {
        /**
         * The call is paused.
         */
        IsPaused: PlainDescriptor<undefined>;
        /**
         * The call is unpaused.
         */
        IsUnpaused: PlainDescriptor<undefined>;
        /**
         * The call is whitelisted and cannot be paused.
         */
        Unpausable: PlainDescriptor<undefined>;
        /**
        
         */
        NotFound: PlainDescriptor<undefined>;
    };
    ImOnline: {
        /**
         * Non existent public key.
         */
        InvalidKey: PlainDescriptor<undefined>;
        /**
         * Duplicated heartbeat.
         */
        DuplicatedHeartbeat: PlainDescriptor<undefined>;
    };
    Identity: {
        /**
         * Too many subs-accounts.
         */
        TooManySubAccounts: PlainDescriptor<undefined>;
        /**
         * Account isn't found.
         */
        NotFound: PlainDescriptor<undefined>;
        /**
         * Account isn't named.
         */
        NotNamed: PlainDescriptor<undefined>;
        /**
         * Empty index.
         */
        EmptyIndex: PlainDescriptor<undefined>;
        /**
         * Fee is changed.
         */
        FeeChanged: PlainDescriptor<undefined>;
        /**
         * No identity found.
         */
        NoIdentity: PlainDescriptor<undefined>;
        /**
         * Sticky judgement.
         */
        StickyJudgement: PlainDescriptor<undefined>;
        /**
         * Judgement given.
         */
        JudgementGiven: PlainDescriptor<undefined>;
        /**
         * Invalid judgement.
         */
        InvalidJudgement: PlainDescriptor<undefined>;
        /**
         * The index is invalid.
         */
        InvalidIndex: PlainDescriptor<undefined>;
        /**
         * The target is invalid.
         */
        InvalidTarget: PlainDescriptor<undefined>;
        /**
         * Maximum amount of registrars reached. Cannot add any more.
         */
        TooManyRegistrars: PlainDescriptor<undefined>;
        /**
         * Account ID is already named.
         */
        AlreadyClaimed: PlainDescriptor<undefined>;
        /**
         * Sender is not a sub-account.
         */
        NotSub: PlainDescriptor<undefined>;
        /**
         * Sub-account isn't owned by sender.
         */
        NotOwned: PlainDescriptor<undefined>;
        /**
         * The provided judgement was for a different identity.
         */
        JudgementForDifferentIdentity: PlainDescriptor<undefined>;
        /**
         * Error that occurs when there is an issue paying for judgement.
         */
        JudgementPaymentFailed: PlainDescriptor<undefined>;
        /**
         * The provided suffix is too long.
         */
        InvalidSuffix: PlainDescriptor<undefined>;
        /**
         * The sender does not have permission to issue a username.
         */
        NotUsernameAuthority: PlainDescriptor<undefined>;
        /**
         * The authority cannot allocate any more usernames.
         */
        NoAllocation: PlainDescriptor<undefined>;
        /**
         * The signature on a username was not valid.
         */
        InvalidSignature: PlainDescriptor<undefined>;
        /**
         * Setting this username requires a signature, but none was provided.
         */
        RequiresSignature: PlainDescriptor<undefined>;
        /**
         * The username does not meet the requirements.
         */
        InvalidUsername: PlainDescriptor<undefined>;
        /**
         * The username is already taken.
         */
        UsernameTaken: PlainDescriptor<undefined>;
        /**
         * The requested username does not exist.
         */
        NoUsername: PlainDescriptor<undefined>;
        /**
         * The username cannot be forcefully removed because it can still be accepted.
         */
        NotExpired: PlainDescriptor<undefined>;
    };
    Utility: {
        /**
         * Too many calls batched.
         */
        TooManyCalls: PlainDescriptor<undefined>;
    };
    Multisig: {
        /**
         * Threshold must be 2 or greater.
         */
        MinimumThreshold: PlainDescriptor<undefined>;
        /**
         * Call is already approved by this signatory.
         */
        AlreadyApproved: PlainDescriptor<undefined>;
        /**
         * Call doesn't need any (more) approvals.
         */
        NoApprovalsNeeded: PlainDescriptor<undefined>;
        /**
         * There are too few signatories in the list.
         */
        TooFewSignatories: PlainDescriptor<undefined>;
        /**
         * There are too many signatories in the list.
         */
        TooManySignatories: PlainDescriptor<undefined>;
        /**
         * The signatories were provided out of order; they should be ordered.
         */
        SignatoriesOutOfOrder: PlainDescriptor<undefined>;
        /**
         * The sender was contained in the other signatories; it shouldn't be.
         */
        SenderInSignatories: PlainDescriptor<undefined>;
        /**
         * Multisig operation not found when attempting to cancel.
         */
        NotFound: PlainDescriptor<undefined>;
        /**
         * Only the account that originally created the multisig is able to cancel it.
         */
        NotOwner: PlainDescriptor<undefined>;
        /**
         * No timepoint was given, yet the multisig operation is already underway.
         */
        NoTimepoint: PlainDescriptor<undefined>;
        /**
         * A different timepoint was given to the multisig operation that is underway.
         */
        WrongTimepoint: PlainDescriptor<undefined>;
        /**
         * A timepoint was given, yet no multisig operation is underway.
         */
        UnexpectedTimepoint: PlainDescriptor<undefined>;
        /**
         * The maximum weight information provided was too low.
         */
        MaxWeightTooLow: PlainDescriptor<undefined>;
        /**
         * The data to be stored is already stored.
         */
        AlreadyStored: PlainDescriptor<undefined>;
    };
    Ethereum: {
        /**
         * Signature is invalid.
         */
        InvalidSignature: PlainDescriptor<undefined>;
        /**
         * Pre-log is present, therefore transact is not allowed.
         */
        PreLogExists: PlainDescriptor<undefined>;
    };
    EVM: {
        /**
         * Not enough balance to perform action
         */
        BalanceLow: PlainDescriptor<undefined>;
        /**
         * Calculating total fee overflowed
         */
        FeeOverflow: PlainDescriptor<undefined>;
        /**
         * Calculating total payment overflowed
         */
        PaymentOverflow: PlainDescriptor<undefined>;
        /**
         * Withdraw fee failed
         */
        WithdrawFailed: PlainDescriptor<undefined>;
        /**
         * Gas price is too low.
         */
        GasPriceTooLow: PlainDescriptor<undefined>;
        /**
         * Nonce is invalid
         */
        InvalidNonce: PlainDescriptor<undefined>;
        /**
         * Gas limit is too low.
         */
        GasLimitTooLow: PlainDescriptor<undefined>;
        /**
         * Gas limit is too high.
         */
        GasLimitTooHigh: PlainDescriptor<undefined>;
        /**
         * The chain id is invalid.
         */
        InvalidChainId: PlainDescriptor<undefined>;
        /**
         * the signature is invalid.
         */
        InvalidSignature: PlainDescriptor<undefined>;
        /**
         * EVM reentrancy
         */
        Reentrancy: PlainDescriptor<undefined>;
        /**
         * EIP-3607,
         */
        TransactionMustComeFromEOA: PlainDescriptor<undefined>;
        /**
         * Undefined error.
         */
        Undefined: PlainDescriptor<undefined>;
        /**
        
         */
        NotAllowed: PlainDescriptor<undefined>;
    };
    HotfixSufficients: {
        /**
         * Maximum address count exceeded
         */
        MaxAddressCountExceeded: PlainDescriptor<undefined>;
    };
    Proxy: {
        /**
         * There are too many proxies registered or too many announcements pending.
         */
        TooMany: PlainDescriptor<undefined>;
        /**
         * Proxy registration not found.
         */
        NotFound: PlainDescriptor<undefined>;
        /**
         * Sender is not a proxy of the account to be proxied.
         */
        NotProxy: PlainDescriptor<undefined>;
        /**
         * A call which is incompatible with the proxy type's filter was attempted.
         */
        Unproxyable: PlainDescriptor<undefined>;
        /**
         * Account is already a proxy.
         */
        Duplicate: PlainDescriptor<undefined>;
        /**
         * Call may not be made by proxy because it may escalate its privileges.
         */
        NoPermission: PlainDescriptor<undefined>;
        /**
         * Announcement, if made at all, was made too recently.
         */
        Unannounced: PlainDescriptor<undefined>;
        /**
         * Cannot add self as proxy.
         */
        NoSelfProxy: PlainDescriptor<undefined>;
    };
    Registration: {
        /**
        
         */
        NoneValue: PlainDescriptor<undefined>;
        /**
        
         */
        StorageOverflow: PlainDescriptor<undefined>;
        /**
        
         */
        IpfsNodeIdRequired: PlainDescriptor<undefined>;
        /**
        
         */
        NodeAlreadyRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        NotAminer: PlainDescriptor<undefined>;
        /**
        
         */
        IpfsNodeIdAlreadyRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        AddressUidNotFoundOnBittensor: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidAccountId: PlainDescriptor<undefined>;
        /**
        
         */
        InsufficientStake: PlainDescriptor<undefined>;
        /**
        
         */
        InsufficientBalanceForFee: PlainDescriptor<undefined>;
        /**
        
         */
        FeeTooHigh: PlainDescriptor<undefined>;
        /**
        
         */
        NodeTypeDisabled: PlainDescriptor<undefined>;
        /**
        
         */
        NodeTypeMismatch: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        NotNodeOwner: PlainDescriptor<undefined>;
        /**
        
         */
        NotAProxyAccount: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidProxyType: PlainDescriptor<undefined>;
        /**
        
         */
        AccountNotRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotInUids: PlainDescriptor<undefined>;
        /**
        
         */
        NodeCooldownPeriodNotExpired: PlainDescriptor<undefined>;
        /**
        
         */
        OwnerAlreadyRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidNodeType: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotDegradedStorageMiner: PlainDescriptor<undefined>;
        /**
        
         */
        TooManyRequests: PlainDescriptor<undefined>;
        /**
        
         */
        AccountBanned: PlainDescriptor<undefined>;
        /**
        
         */
        ExceededMaxWhitelistedValidators: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotWhitelisted: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidSignature: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidKeyType: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidChallenge: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidChallengeDomain: PlainDescriptor<undefined>;
        /**
        
         */
        ChallengeExpired: PlainDescriptor<undefined>;
        /**
        
         */
        ChallengeReused: PlainDescriptor<undefined>;
        /**
        
         */
        GenesisMismatch: PlainDescriptor<undefined>;
        /**
        
         */
        PublicKeyMismatch: PlainDescriptor<undefined>;
        /**
        
         */
        ChallengeMismatch: PlainDescriptor<undefined>;
        /**
         * Batch unregistration failed due to too many nodes
         */
        TooManyUnverifiedNodes: PlainDescriptor<undefined>;
        /**
        
         */
        NodeAlreadyVerified: PlainDescriptor<undefined>;
        /**
        
         */
        Unauthorized: PlainDescriptor<undefined>;
    };
    ExecutionUnit: {
        /**
        
         */
        MetricsNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidJson: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidCid: PlainDescriptor<undefined>;
        /**
        
         */
        StorageOverflow: PlainDescriptor<undefined>;
        /**
        
         */
        IpfsError: PlainDescriptor<undefined>;
        /**
        
         */
        TooManyRequests: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidNodeType: PlainDescriptor<undefined>;
        /**
        
         */
        StorageBelowTwoTB: PlainDescriptor<undefined>;
        /**
         * Primary network interface is not provided.
         */
        NoPrimaryNetworkInterface: PlainDescriptor<undefined>;
        /**
         * Disks array is empty.
         */
        EmptyDisksArray: PlainDescriptor<undefined>;
        /**
        
         */
        MemoryExceedsFiveTB: PlainDescriptor<undefined>;
        /**
        
         */
        ConsensusNotReached: PlainDescriptor<undefined>;
        /**
        
         */
        SuccessfulPinsExceedTotal: PlainDescriptor<undefined>;
    };
    Metagraph: {
        /**
         * Value not found
         */
        NoneValue: PlainDescriptor<undefined>;
        /**
         * Storage overflow
         */
        StorageOverflow: PlainDescriptor<undefined>;
        /**
         * Error during signing
         */
        SigningError: PlainDescriptor<undefined>;
        /**
         * Invalid signature
         */
        InvalidSignature: PlainDescriptor<undefined>;
        /**
         * Invalid UID format
         */
        InvalidUIDFormat: PlainDescriptor<undefined>;
        /**
         * Error decoding hex
         */
        DecodingError: PlainDescriptor<undefined>;
        /**
        
         */
        ValidatorAlreadyWhitelisted: PlainDescriptor<undefined>;
        /**
        
         */
        ValidatorNotWhitelisted: PlainDescriptor<undefined>;
        /**
        
         */
        NotWhitelistedValidator: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidNodeType: PlainDescriptor<undefined>;
    };
    Marketplace: {
        /**
        
         */
        NoneValue: PlainDescriptor<undefined>;
        /**
        
         */
        NotSubscriptionOwner: PlainDescriptor<undefined>;
        /**
        
         */
        SubscriptionNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        TooManySharedUsers: PlainDescriptor<undefined>;
        /**
        
         */
        InsufficientPermissions: PlainDescriptor<undefined>;
        /**
        
         */
        CannotTransferToSelf: PlainDescriptor<undefined>;
        /**
        
         */
        RecipientTooManySubscriptions: PlainDescriptor<undefined>;
        /**
        
         */
        CannotModifyOwnerPermissions: PlainDescriptor<undefined>;
        /**
        
         */
        CannotTransferInactiveSubscription: PlainDescriptor<undefined>;
        /**
        
         */
        AlreadyHasAccess: PlainDescriptor<undefined>;
        /**
        
         */
        NoExistingAccess: PlainDescriptor<undefined>;
        /**
        
         */
        NotAuthorized: PlainDescriptor<undefined>;
        /**
        
         */
        InsufficientBalance: PlainDescriptor<undefined>;
        /**
        
         */
        PackageNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        SubscriptionNotActive: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidSubscriptionType: PlainDescriptor<undefined>;
        /**
        
         */
        StorageLimitExceeded: PlainDescriptor<undefined>;
        /**
        
         */
        StorageRequestNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        PlanNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidPlanType: PlainDescriptor<undefined>;
        /**
        
         */
        AlreadyHasActiveSubscription: PlainDescriptor<undefined>;
        /**
        
         */
        PlanSuspended: PlainDescriptor<undefined>;
        /**
        
         */
        InsufficientFreeCredits: PlainDescriptor<undefined>;
        /**
        
         */
        LocationNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidPlanLimits: PlainDescriptor<undefined>;
        /**
        
         */
        NodeTypeDisabled: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidStorageReduction: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidSubscriptionUsage: PlainDescriptor<undefined>;
        /**
        
         */
        ComputeResourceExceeded: PlainDescriptor<undefined>;
        /**
        
         */
        NoActiveSubscription: PlainDescriptor<undefined>;
        /**
        
         */
        BackupAlreadyEnabled: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidImageSelection: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidNodeType: PlainDescriptor<undefined>;
        /**
         * No active compute subscription found for the user
         */
        NoActiveComputeSubscription: PlainDescriptor<undefined>;
        /**
         * The plan does not match the user's active subscription
         */
        InvalidPlanForSubscription: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidPlanConfiguration: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidOSDiskImageUrl: PlainDescriptor<undefined>;
        /**
         * No subscription found for the given user
         */
        NoSubscriptionFound: PlainDescriptor<undefined>;
        /**
        
         */
        StorageOperationsDisabled: PlainDescriptor<undefined>;
        /**
        
         */
        PlanOperationDisabled: PlainDescriptor<undefined>;
        /**
        
         */
        TooManyRequests: PlainDescriptor<undefined>;
        /**
        
         */
        OperationNotAllowed: PlainDescriptor<undefined>;
    };
    Bittensor: {
        /**
        
         */
        NoneValue: PlainDescriptor<undefined>;
        /**
        
         */
        StorageOverflow: PlainDescriptor<undefined>;
        /**
        
         */
        SubmissionDisabled: PlainDescriptor<undefined>;
    };
    SubAccount: {
        /**
         * Sender is not a sub account
         */
        NoSubAccount: PlainDescriptor<undefined>;
        /**
         * Sender is not a sub account of the given address
         */
        NotAllowed: PlainDescriptor<undefined>;
        /**
         * Cannot remove all sub-accounts
         */
        NoAccountsLeft: PlainDescriptor<undefined>;
        /**
         * Cannot add a sub account twice
         */
        AlreadySubAccount: PlainDescriptor<undefined>;
        /**
         * Main account cannot be a sub-account
         */
        MainCannotBeSubAccount: PlainDescriptor<undefined>;
        /**
         * Cannot be a Sub Account of Itself
         */
        CannotBeOwnSubAccount: PlainDescriptor<undefined>;
        /**
         * Reached Limit
         */
        TooManySubAccounts: PlainDescriptor<undefined>;
        /**
         * Invalid role change
         */
        InvalidRoleChange: PlainDescriptor<undefined>;
    };
    Notifications: {
        /**
         * No notifications found for the user
         */
        NoNotifications: PlainDescriptor<undefined>;
        /**
         * Notification index is invalid
         */
        InvalidNotificationIndex: PlainDescriptor<undefined>;
        /**
        
         */
        CooldownNotElapsed: PlainDescriptor<undefined>;
        /**
        
         */
        AccountBanned: PlainDescriptor<undefined>;
    };
    AccountProfile: {
        /**
         * The hex string provided is invalid.
         */
        InvalidHexString: PlainDescriptor<undefined>;
        /**
         * The account already has a username set.
         */
        UsernameAlreadySet: PlainDescriptor<undefined>;
        /**
        
         */
        UsernameAlreadyTaken: PlainDescriptor<undefined>;
    };
    Utils: {
        /**
        
         */
        NoneValue: PlainDescriptor<undefined>;
        /**
        
         */
        StorageOverflow: PlainDescriptor<undefined>;
    };
    RankingStorage: {
        /**
         * Value is None.
         */
        NoneValue: PlainDescriptor<undefined>;
        /**
         * Storage overflow occurred.
         */
        StorageOverflow: PlainDescriptor<undefined>;
        /**
         * Input provided is invalid.
         */
        InvalidInput: PlainDescriptor<undefined>;
        /**
         * Error during conversion.
         */
        ConversionError: PlainDescriptor<undefined>;
        /**
         * No signer was available to submit the transaction
         */
        NoSignerAvailable: PlainDescriptor<undefined>;
        /**
         * Could not acquire the lock for updating rankings
         */
        CannotAcquireLock: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidNodeType: PlainDescriptor<undefined>;
    };
    RankingCompute: {
        /**
         * Value is None.
         */
        NoneValue: PlainDescriptor<undefined>;
        /**
         * Storage overflow occurred.
         */
        StorageOverflow: PlainDescriptor<undefined>;
        /**
         * Input provided is invalid.
         */
        InvalidInput: PlainDescriptor<undefined>;
        /**
         * Error during conversion.
         */
        ConversionError: PlainDescriptor<undefined>;
        /**
         * No signer was available to submit the transaction
         */
        NoSignerAvailable: PlainDescriptor<undefined>;
        /**
         * Could not acquire the lock for updating rankings
         */
        CannotAcquireLock: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidNodeType: PlainDescriptor<undefined>;
    };
    RankingValidators: {
        /**
         * Value is None.
         */
        NoneValue: PlainDescriptor<undefined>;
        /**
         * Storage overflow occurred.
         */
        StorageOverflow: PlainDescriptor<undefined>;
        /**
         * Input provided is invalid.
         */
        InvalidInput: PlainDescriptor<undefined>;
        /**
         * Error during conversion.
         */
        ConversionError: PlainDescriptor<undefined>;
        /**
         * No signer was available to submit the transaction
         */
        NoSignerAvailable: PlainDescriptor<undefined>;
        /**
         * Could not acquire the lock for updating rankings
         */
        CannotAcquireLock: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidNodeType: PlainDescriptor<undefined>;
    };
    Credits: {
        /**
        
         */
        NoneValue: PlainDescriptor<undefined>;
        /**
        
         */
        StorageOverflow: PlainDescriptor<undefined>;
        /**
        
         */
        InsufficientFreeCredits: PlainDescriptor<undefined>;
        /**
        
         */
        UserNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        InsufficientLockedCredits: PlainDescriptor<undefined>;
        /**
        
         */
        NotAuthorized: PlainDescriptor<undefined>;
        /**
        
         */
        AuthorityAlreadyExists: PlainDescriptor<undefined>;
        /**
        
         */
        AuthorityNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidConversionAmount: PlainDescriptor<undefined>;
        /**
        
         */
        InsufficientBalance: PlainDescriptor<undefined>;
        /**
        
         */
        ConversionFailed: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidReferralCode: PlainDescriptor<undefined>;
        /**
        
         */
        ReferralCodeCooldown: PlainDescriptor<undefined>;
        /**
        
         */
        NoReferralCodeUsed: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidRefferalOwner: PlainDescriptor<undefined>;
        /**
        
         */
        CreditAlreadyFulfilled: PlainDescriptor<undefined>;
        /**
        
         */
        LockedCreditNotFound: PlainDescriptor<undefined>;
        /**
         * Returned if the account has insufficient free credits
         * Returned if the current block is outside the specified lock period
         */
        OutsideLockPeriod: PlainDescriptor<undefined>;
        /**
         * Returned if no active lock period is set
         */
        NoActiveLockPeriod: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidLockPeriod: PlainDescriptor<undefined>;
        /**
         * Minimum lock amount is not set
         */
        MinLockAmountNotSet: PlainDescriptor<undefined>;
        /**
         * Locked amount is less than the minimum required lock amount
         */
        InsufficientLockAmount: PlainDescriptor<undefined>;
        /**
        
         */
        InsufficientAlphaBalance: PlainDescriptor<undefined>;
    };
    ContainerRegistry: {
        /**
         * Repository already exists
         */
        RepositoryAlreadyExists: PlainDescriptor<undefined>;
        /**
         * Maximum tags limit reached
         */
        MaxTagsLimitReached: PlainDescriptor<undefined>;
        /**
         * Input exceeds maximum allowed length
         */
        ExceedsMaxLength: PlainDescriptor<undefined>;
        /**
         * Repository not found
         */
        RepositoryNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        MaxImageCidsLimitReached: PlainDescriptor<undefined>;
        /**
         * Space already exists
         */
        SpaceAlreadyExists: PlainDescriptor<undefined>;
        /**
         * Space not found
         */
        SpaceNotFound: PlainDescriptor<undefined>;
        /**
         * Not authorized to access the space
         */
        NotAuthorized: PlainDescriptor<undefined>;
        /**
         * Maximum space members limit reached
         */
        MaxSpaceMembersReached: PlainDescriptor<undefined>;
        /**
         * The image name cannot be empty
         */
        EmptyImageName: PlainDescriptor<undefined>;
        /**
         * The digest cannot be empty
         */
        EmptyDigest: PlainDescriptor<undefined>;
        /**
         * The CID cannot be empty
         */
        EmptyCid: PlainDescriptor<undefined>;
        /**
         * The digest information cannot be empty
         */
        EmptyDigestInfo: PlainDescriptor<undefined>;
        /**
         * The CID information cannot be empty
         */
        EmptyCidInfo: PlainDescriptor<undefined>;
        /**
         * Not a member of the space
         */
        NotSpaceMember: PlainDescriptor<undefined>;
        /**
        
         */
        SpaceDoesNotExist: PlainDescriptor<undefined>;
        /**
        
         */
        NotSpaceOwner: PlainDescriptor<undefined>;
        /**
         * User already has a space
         */
        UserAlreadyHasSpace: PlainDescriptor<undefined>;
    };
    AlphaBridge: {
        /**
         * Caller is not a guardian
         */
        NotGuardian: PlainDescriptor<undefined>;
        /**
         * Guardian has already voted on this deposit
         */
        AlreadyVoted: PlainDescriptor<undefined>;
        /**
         * User has insufficient hAlpha balance
         */
        InsufficientBalance: PlainDescriptor<undefined>;
        /**
         * Minting would exceed the global mint cap
         */
        CapExceeded: PlainDescriptor<undefined>;
        /**
         * Bridge is currently paused
         */
        BridgePaused: PlainDescriptor<undefined>;
        /**
         * Deposit not found
         */
        DepositNotFound: PlainDescriptor<undefined>;
        /**
         * Withdrawal request not found
         */
        WithdrawalRequestNotFound: PlainDescriptor<undefined>;
        /**
         * Invalid status for this operation
         */
        InvalidStatus: PlainDescriptor<undefined>;
        /**
         * Threshold cannot be zero
         */
        ThresholdTooLow: PlainDescriptor<undefined>;
        /**
         * Threshold exceeds guardian count
         */
        ThresholdTooHigh: PlainDescriptor<undefined>;
        /**
         * Too many guardians provided
         */
        TooManyGuardians: PlainDescriptor<undefined>;
        /**
         * Failed to convert between numeric balance types
         */
        AmountConversionFailed: PlainDescriptor<undefined>;
        /**
         * Failed to mint tokens
         */
        MintFailed: PlainDescriptor<undefined>;
        /**
         * Arithmetic overflow
         */
        ArithmeticOverflow: PlainDescriptor<undefined>;
        /**
         * Deposit already completed
         */
        DepositAlreadyCompleted: PlainDescriptor<undefined>;
        /**
         * Withdrawal request already completed or failed
         */
        WithdrawalRequestAlreadyFinalized: PlainDescriptor<undefined>;
        /**
         * Amount must be greater than zero
         */
        AmountTooSmall: PlainDescriptor<undefined>;
        /**
         * Accounting underflow - indicates a bug
         */
        AccountingUnderflow: PlainDescriptor<undefined>;
        /**
         * Record is not finalized (not Completed or Cancelled)
         */
        RecordNotFinalized: PlainDescriptor<undefined>;
        /**
         * TTL has not expired yet
         */
        TTLNotExpired: PlainDescriptor<undefined>;
        /**
         * TTL must be greater than zero
         */
        InvalidTTL: PlainDescriptor<undefined>;
        /**
         * Recomputed request ID does not match the provided one
         */
        InvalidRequestId: PlainDescriptor<undefined>;
        /**
         * Withdrawal amount must be divisible by the conversion factor (no dust)
         */
        AmountNotBridgeable: PlainDescriptor<undefined>;
    };
    PalletIp: {
        /**
        
         */
        NoAvailableIp: PlainDescriptor<undefined>;
        /**
        
         */
        VmAlreadyHasIp: PlainDescriptor<undefined>;
        /**
        
         */
        VmHasNoIp: PlainDescriptor<undefined>;
        /**
        
         */
        IpAlreadyExists: PlainDescriptor<undefined>;
        /**
        
         */
        RoleAlreadyHasIp: PlainDescriptor<undefined>;
    };
    IpfsPallet: {
        /**
        
         */
        NoneValue: PlainDescriptor<undefined>;
        /**
        
         */
        StorageOverflow: PlainDescriptor<undefined>;
        /**
        
         */
        RequestDoesNotExists: PlainDescriptor<undefined>;
        /**
        
         */
        OwnerNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        TooManyUnpinRequests: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidInput: PlainDescriptor<undefined>;
        /**
        
         */
        RequestAlreadyExists: PlainDescriptor<undefined>;
        /**
        
         */
        TooManyRequests: PlainDescriptor<undefined>;
        /**
        
         */
        ValidatorSelectionFailed: PlainDescriptor<undefined>;
        /**
        
         */
        NoValidatorsAvailable: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotRegistered: PlainDescriptor<undefined>;
        /**
        
         */
        NodeNotValidator: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidCid: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidJson: PlainDescriptor<undefined>;
        /**
        
         */
        IpfsError: PlainDescriptor<undefined>;
        /**
        
         */
        MaxUnpinRequestsExceeded: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidNodeType: PlainDescriptor<undefined>;
        /**
        
         */
        MinerNotLocked: PlainDescriptor<undefined>;
        /**
        
         */
        AssignmentNotEnabled: PlainDescriptor<undefined>;
        /**
        
         */
        StorageRequestsCleared: PlainDescriptor<undefined>;
        /**
        
         */
        FileHashBlacklisted: PlainDescriptor<undefined>;
        /**
        
         */
        MinersNotLocked: PlainDescriptor<undefined>;
        /**
        
         */
        UnauthorizedLocker: PlainDescriptor<undefined>;
        /**
        
         */
        MinersAlreadyLocked: PlainDescriptor<undefined>;
        /**
        
         */
        NodeIdTooLong: PlainDescriptor<undefined>;
        /**
        
         */
        RequestNotFound: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidReputationPoints: PlainDescriptor<undefined>;
        /**
        
         */
        UserIsBlacklisted: PlainDescriptor<undefined>;
        /**
        
         */
        InvalidAccountId: PlainDescriptor<undefined>;
        /**
        
         */
        NotCurrentEpochValidator: PlainDescriptor<undefined>;
        /**
        
         */
        FileSizeOverflow: PlainDescriptor<undefined>;
        /**
        
         */
        NotAuthorized: PlainDescriptor<undefined>;
        /**
        
         */
        StorageRequestFailed: PlainDescriptor<undefined>;
    };
    Arion: {
        /**
         * Epoch is not strictly increasing.
         */
        EpochRegression: PlainDescriptor<undefined>;
        /**
         * Epoch already exists.
         */
        EpochAlreadyExists: PlainDescriptor<undefined>;
        /**
         * Miner list must be sorted by uid and unique.
         */
        MinerListNotSortedOrNotUnique: PlainDescriptor<undefined>;
        /**
         * Too many miners.
         */
        TooManyMiners: PlainDescriptor<undefined>;
        /**
         * Too many stats updates in one call.
         */
        TooManyStatsUpdates: PlainDescriptor<undefined>;
        /**
         * Stats bucket regression.
         */
        StatsBucketRegression: PlainDescriptor<undefined>;
        /**
         * Family is not registered (per `FamilyRegistry` hook).
         */
        FamilyNotRegistered: PlainDescriptor<undefined>;
        /**
         * Proxy verification failed (per `ProxyVerifier` hook).
         */
        ProxyVerificationFailed: PlainDescriptor<undefined>;
        /**
         * Too many families.
         */
        TooManyFamilies: PlainDescriptor<undefined>;
        /**
         * Too many active children total.
         */
        TooManyChildrenTotal: PlainDescriptor<undefined>;
        /**
         * Too many active children in this family.
         */
        TooManyChildrenInFamily: PlainDescriptor<undefined>;
        /**
         * Child is already registered.
         */
        ChildAlreadyRegistered: PlainDescriptor<undefined>;
        /**
         * Child is not registered.
         */
        ChildNotRegistered: PlainDescriptor<undefined>;
        /**
         * Child is in cooldown.
         */
        ChildInCooldown: PlainDescriptor<undefined>;
        /**
         * Node id is already registered.
         */
        NodeIdAlreadyRegistered: PlainDescriptor<undefined>;
        /**
         * Node id is in cooldown.
         */
        NodeIdInCooldown: PlainDescriptor<undefined>;
        /**
         * Invalid node signature.
         */
        InvalidNodeSignature: PlainDescriptor<undefined>;
        /**
         * Child is not currently active (cannot be deregistered).
         */
        ChildNotActive: PlainDescriptor<undefined>;
        /**
         * Child is not in unbonding state.
         */
        NotUnbonding: PlainDescriptor<undefined>;
        /**
         * Unbonding not finished yet.
         */
        UnbondingNotReady: PlainDescriptor<undefined>;
        /**
         * Failed to reserve required deposit.
         */
        InsufficientDeposit: PlainDescriptor<undefined>;
        /**
         * CRUSH map includes a miner that is not registered (when enforcement is enabled).
         */
        MinerNotRegistered: PlainDescriptor<undefined>;
        /**
         * Weight bucket regression.
         */
        WeightBucketRegression: PlainDescriptor<undefined>;
        /**
         * Too many node weight updates.
         */
        TooManyNodeWeightUpdates: PlainDescriptor<undefined>;
        /**
         * Attestation bucket regression.
         */
        AttestationBucketRegression: PlainDescriptor<undefined>;
        /**
         * Too many attestations in one call.
         */
        TooManyAttestations: PlainDescriptor<undefined>;
        /**
         * Attestation list is full for this bucket.
         */
        AttestationBucketFull: PlainDescriptor<undefined>;
        /**
         * Invalid attestation signature.
         */
        InvalidAttestationSignature: PlainDescriptor<undefined>;
        /**
         * Attestation commitment already exists for this epoch.
         */
        AttestationCommitmentAlreadyExists: PlainDescriptor<undefined>;
        /**
         * Invalid content hash length (expected 32 bytes for BLAKE3).
         */
        InvalidContentHashLength: PlainDescriptor<undefined>;
        /**
         * Warden is already registered.
         */
        WardenAlreadyRegistered: PlainDescriptor<undefined>;
        /**
         * Warden is not registered.
         */
        WardenNotRegistered: PlainDescriptor<undefined>;
        /**
         * Attestation submitted by unregistered warden.
         */
        UnregisteredWarden: PlainDescriptor<undefined>;
        /**
         * Cannot prune buckets within retention period.
         */
        PruningWithinRetentionPeriod: PlainDescriptor<undefined>;
    };
};
type IConstants = {
    System: {
        /**
         * Block & extrinsics weights: base values and limits.
         */
        BlockWeights: PlainDescriptor<Anonymize<In7a38730s6qs>>;
        /**
         * The maximum length of a block (in bytes).
         */
        BlockLength: PlainDescriptor<Anonymize<If15el53dd76v9>>;
        /**
         * Maximum number of block number to block hash mappings to keep (oldest pruned first).
         */
        BlockHashCount: PlainDescriptor<bigint>;
        /**
         * The weight of runtime database operations the runtime can invoke.
         */
        DbWeight: PlainDescriptor<Anonymize<I9s0ave7t0vnrk>>;
        /**
         * Get the chain's in-code version.
         */
        Version: PlainDescriptor<Anonymize<Ic6nglu2db2c36>>;
        /**
         * The designated SS58 prefix of this chain.
         *
         * This replaces the "ss58Format" property declared in the chain spec. Reason is
         * that the runtime should know about the prefix in order to make use of it as
         * an identifier of the chain.
         */
        SS58Prefix: PlainDescriptor<number>;
    };
    Timestamp: {
        /**
         * The minimum period between blocks.
         *
         * Be aware that this is different to the *expected* period that the block production
         * apparatus provides. Your chosen consensus system will generally work with this to
         * determine a sensible block time. For example, in the Aura pallet it will be double this
         * period on default settings.
         */
        MinimumPeriod: PlainDescriptor<bigint>;
    };
    Assets: {
        /**
         * Max number of items to destroy per `destroy_accounts` and `destroy_approvals` call.
         *
         * Must be configured to result in a weight that makes each call fit in a block.
         */
        RemoveItemsLimit: PlainDescriptor<number>;
        /**
         * The basic amount of funds that must be reserved for an asset.
         */
        AssetDeposit: PlainDescriptor<bigint>;
        /**
         * The amount of funds that must be reserved for a non-provider asset account to be
         * maintained.
         */
        AssetAccountDeposit: PlainDescriptor<bigint>;
        /**
         * The basic amount of funds that must be reserved when adding metadata to your asset.
         */
        MetadataDepositBase: PlainDescriptor<bigint>;
        /**
         * The additional funds that must be reserved for the number of bytes you store in your
         * metadata.
         */
        MetadataDepositPerByte: PlainDescriptor<bigint>;
        /**
         * The amount of funds that must be reserved when creating a new approval.
         */
        ApprovalDeposit: PlainDescriptor<bigint>;
        /**
         * The maximum length of a name or symbol stored on-chain.
         */
        StringLimit: PlainDescriptor<number>;
    };
    Balances: {
        /**
         * The minimum amount required to keep an account open. MUST BE GREATER THAN ZERO!
         *
         * If you *really* need it to be zero, you can enable the feature `insecure_zero_ed` for
         * this pallet. However, you do so at your own risk: this will open up a major DoS vector.
         * In case you have multiple sources of provider references, you may also get unexpected
         * behaviour if you set this to zero.
         *
         * Bottom line: Do yourself a favour and make it at least one!
         */
        ExistentialDeposit: PlainDescriptor<bigint>;
        /**
         * The maximum number of locks that should exist on an account.
         * Not strictly enforced, but used for weight estimation.
         *
         * Use of locks is deprecated in favour of freezes. See `https://github.com/paritytech/substrate/pull/12951/`
         */
        MaxLocks: PlainDescriptor<number>;
        /**
         * The maximum number of named reserves that can exist on an account.
         *
         * Use of reserves is deprecated in favour of holds. See `https://github.com/paritytech/substrate/pull/12951/`
         */
        MaxReserves: PlainDescriptor<number>;
        /**
         * The maximum number of individual freeze locks that can exist on an account at any time.
         */
        MaxFreezes: PlainDescriptor<number>;
    };
    TransactionPayment: {
        /**
         * A fee multiplier for `Operational` extrinsics to compute "virtual tip" to boost their
         * `priority`
         *
         * This value is multiplied by the `final_fee` to obtain a "virtual tip" that is later
         * added to a tip component in regular `priority` calculations.
         * It means that a `Normal` transaction can front-run a similarly-sized `Operational`
         * extrinsic (with no tip), by including a tip value greater than the virtual tip.
         *
         * ```rust,ignore
         * // For `Normal`
         * let priority = priority_calc(tip);
         *
         * // For `Operational`
         * let virtual_tip = (inclusion_fee + tip) * OperationalFeeMultiplier;
         * let priority = priority_calc(tip + virtual_tip);
         * ```
         *
         * Note that since we use `final_fee` the multiplier applies also to the regular `tip`
         * sent with the transaction. So, not only does the transaction get a priority bump based
         * on the `inclusion_fee`, but we also amplify the impact of tips applied to `Operational`
         * transactions.
         */
        OperationalFeeMultiplier: PlainDescriptor<number>;
    };
    Babe: {
        /**
         * The amount of time, in slots, that each epoch should last.
         * NOTE: Currently it is not possible to change the epoch duration after
         * the chain has started. Attempting to do so will brick block production.
         */
        EpochDuration: PlainDescriptor<bigint>;
        /**
         * The expected average block time at which BABE should be creating
         * blocks. Since BABE is probabilistic it is not trivial to figure out
         * what the expected average block time should be based on the slot
         * duration and the security parameter `c` (where `1 - c` represents
         * the probability of a slot being empty).
         */
        ExpectedBlockTime: PlainDescriptor<bigint>;
        /**
         * Max number of authorities allowed
         */
        MaxAuthorities: PlainDescriptor<number>;
        /**
         * The maximum number of nominators for each validator.
         */
        MaxNominators: PlainDescriptor<number>;
    };
    Grandpa: {
        /**
         * Max Authorities in use
         */
        MaxAuthorities: PlainDescriptor<number>;
        /**
         * The maximum number of nominators for each validator.
         */
        MaxNominators: PlainDescriptor<number>;
        /**
         * The maximum number of entries to keep in the set id to session index mapping.
         *
         * Since the `SetIdSession` map is only used for validating equivocations this
         * value should relate to the bonding duration of whatever staking system is
         * being used (if any). If equivocation handling is not enabled then this value
         * can be zero.
         */
        MaxSetIdSessionEntries: PlainDescriptor<bigint>;
    };
    Indices: {
        /**
         * The deposit needed for reserving an index.
         */
        Deposit: PlainDescriptor<bigint>;
    };
    Democracy: {
        /**
         * The period between a proposal being approved and enacted.
         *
         * It should generally be a little more than the unstake period to ensure that
         * voting stakers have an opportunity to remove themselves from the system in the case
         * where they are on the losing side of a vote.
         */
        EnactmentPeriod: PlainDescriptor<bigint>;
        /**
         * How often (in blocks) new public referenda are launched.
         */
        LaunchPeriod: PlainDescriptor<bigint>;
        /**
         * How often (in blocks) to check for new votes.
         */
        VotingPeriod: PlainDescriptor<bigint>;
        /**
         * The minimum period of vote locking.
         *
         * It should be no shorter than enactment period to ensure that in the case of an approval,
         * those successful voters are locked into the consequences that their votes entail.
         */
        VoteLockingPeriod: PlainDescriptor<bigint>;
        /**
         * The minimum amount to be used as a deposit for a public referendum proposal.
         */
        MinimumDeposit: PlainDescriptor<bigint>;
        /**
         * Indicator for whether an emergency origin is even allowed to happen. Some chains may
         * want to set this permanently to `false`, others may want to condition it on things such
         * as an upgrade having happened recently.
         */
        InstantAllowed: PlainDescriptor<boolean>;
        /**
         * Minimum voting period allowed for a fast-track referendum.
         */
        FastTrackVotingPeriod: PlainDescriptor<bigint>;
        /**
         * Period in blocks where an external proposal may not be re-submitted after being vetoed.
         */
        CooloffPeriod: PlainDescriptor<bigint>;
        /**
         * The maximum number of votes for an account.
         *
         * Also used to compute weight, an overly big value can
         * lead to extrinsic with very big weight: see `delegate` for instance.
         */
        MaxVotes: PlainDescriptor<number>;
        /**
         * The maximum number of public proposals that can exist at any time.
         */
        MaxProposals: PlainDescriptor<number>;
        /**
         * The maximum number of deposits a public proposal may have at any time.
         */
        MaxDeposits: PlainDescriptor<number>;
        /**
         * The maximum number of items which can be blacklisted.
         */
        MaxBlacklisted: PlainDescriptor<number>;
    };
    Council: {
        /**
         * The maximum weight of a dispatch call that can be proposed and executed.
         */
        MaxProposalWeight: PlainDescriptor<Anonymize<I4q39t5hn830vp>>;
    };
    Vesting: {
        /**
         * The minimum amount transferred to call `vested_transfer`.
         */
        MinVestedTransfer: PlainDescriptor<bigint>;
        /**
        
         */
        MaxVestingSchedules: PlainDescriptor<number>;
    };
    Elections: {
        /**
         * Identifier for the elections-phragmen pallet's lock
         */
        PalletId: PlainDescriptor<FixedSizeBinary<8>>;
        /**
         * How much should be locked up in order to submit one's candidacy.
         */
        CandidacyBond: PlainDescriptor<bigint>;
        /**
         * Base deposit associated with voting.
         *
         * This should be sensibly high to economically ensure the pallet cannot be attacked by
         * creating a gigantic number of votes.
         */
        VotingBondBase: PlainDescriptor<bigint>;
        /**
         * The amount of bond that need to be locked for each vote (32 bytes).
         */
        VotingBondFactor: PlainDescriptor<bigint>;
        /**
         * Number of members to elect.
         */
        DesiredMembers: PlainDescriptor<number>;
        /**
         * Number of runners_up to keep.
         */
        DesiredRunnersUp: PlainDescriptor<number>;
        /**
         * How long each seat is kept. This defines the next block number at which an election
         * round will happen. If set to zero, no elections are ever triggered and the module will
         * be in passive mode.
         */
        TermDuration: PlainDescriptor<bigint>;
        /**
         * The maximum number of candidates in a phragmen election.
         *
         * Warning: This impacts the size of the election which is run onchain. Chose wisely, and
         * consider how it will impact `T::WeightInfo::election_phragmen`.
         *
         * When this limit is reached no more candidates are accepted in the election.
         */
        MaxCandidates: PlainDescriptor<number>;
        /**
         * The maximum number of voters to allow in a phragmen election.
         *
         * Warning: This impacts the size of the election which is run onchain. Chose wisely, and
         * consider how it will impact `T::WeightInfo::election_phragmen`.
         *
         * When the limit is reached the new voters are ignored.
         */
        MaxVoters: PlainDescriptor<number>;
        /**
         * Maximum numbers of votes per voter.
         *
         * Warning: This impacts the size of the election which is run onchain. Chose wisely, and
         * consider how it will impact `T::WeightInfo::election_phragmen`.
         */
        MaxVotesPerVoter: PlainDescriptor<number>;
    };
    ElectionProviderMultiPhase: {
        /**
         * The minimum amount of improvement to the solution score that defines a solution as
         * "better" in the Signed phase.
         */
        BetterSignedThreshold: PlainDescriptor<number>;
        /**
         * The repeat threshold of the offchain worker.
         *
         * For example, if it is 5, that means that at least 5 blocks will elapse between attempts
         * to submit the worker's solution.
         */
        OffchainRepeat: PlainDescriptor<bigint>;
        /**
         * The priority of the unsigned transaction submitted in the unsigned-phase
         */
        MinerTxPriority: PlainDescriptor<bigint>;
        /**
         * Maximum number of signed submissions that can be queued.
         *
         * It is best to avoid adjusting this during an election, as it impacts downstream data
         * structures. In particular, `SignedSubmissionIndices<T>` is bounded on this value. If you
         * update this value during an election, you _must_ ensure that
         * `SignedSubmissionIndices.len()` is less than or equal to the new value. Otherwise,
         * attempts to submit new solutions may cause a runtime panic.
         */
        SignedMaxSubmissions: PlainDescriptor<number>;
        /**
         * Maximum weight of a signed solution.
         *
         * If [`Config::MinerConfig`] is being implemented to submit signed solutions (outside of
         * this pallet), then [`MinerConfig::solution_weight`] is used to compare against
         * this value.
         */
        SignedMaxWeight: PlainDescriptor<Anonymize<I4q39t5hn830vp>>;
        /**
         * The maximum amount of unchecked solutions to refund the call fee for.
         */
        SignedMaxRefunds: PlainDescriptor<number>;
        /**
         * Base reward for a signed solution
         */
        SignedRewardBase: PlainDescriptor<bigint>;
        /**
         * Per-byte deposit for a signed solution.
         */
        SignedDepositByte: PlainDescriptor<bigint>;
        /**
         * Per-weight deposit for a signed solution.
         */
        SignedDepositWeight: PlainDescriptor<bigint>;
        /**
         * The maximum number of winners that can be elected by this `ElectionProvider`
         * implementation.
         *
         * Note: This must always be greater or equal to `T::DataProvider::desired_targets()`.
         */
        MaxWinners: PlainDescriptor<number>;
        /**
        
         */
        MinerMaxLength: PlainDescriptor<number>;
        /**
        
         */
        MinerMaxWeight: PlainDescriptor<Anonymize<I4q39t5hn830vp>>;
        /**
        
         */
        MinerMaxVotesPerVoter: PlainDescriptor<number>;
        /**
        
         */
        MinerMaxWinners: PlainDescriptor<number>;
    };
    Staking: {
        /**
         * Number of eras to keep in history.
         *
         * Following information is kept for eras in `[current_era -
         * HistoryDepth, current_era]`: `ErasStakers`, `ErasStakersClipped`,
         * `ErasValidatorPrefs`, `ErasValidatorReward`, `ErasRewardPoints`,
         * `ErasTotalStake`, `ErasStartSessionIndex`, `ClaimedRewards`, `ErasStakersPaged`,
         * `ErasStakersOverview`.
         *
         * Must be more than the number of eras delayed by session.
         * I.e. active era must always be in history. I.e. `active_era >
         * current_era - history_depth` must be guaranteed.
         *
         * If migrating an existing pallet from storage value to config value,
         * this should be set to same value or greater as in storage.
         *
         * Note: `HistoryDepth` is used as the upper bound for the `BoundedVec`
         * item `StakingLedger.legacy_claimed_rewards`. Setting this value lower than
         * the existing value can lead to inconsistencies in the
         * `StakingLedger` and will need to be handled properly in a migration.
         * The test `reducing_history_depth_abrupt` shows this effect.
         */
        HistoryDepth: PlainDescriptor<number>;
        /**
         * Number of sessions per era.
         */
        SessionsPerEra: PlainDescriptor<number>;
        /**
         * Number of eras that staked funds must remain bonded for.
         */
        BondingDuration: PlainDescriptor<number>;
        /**
         * Number of eras that slashes are deferred by, after computation.
         *
         * This should be less than the bonding duration. Set to 0 if slashes
         * should be applied immediately, without opportunity for intervention.
         */
        SlashDeferDuration: PlainDescriptor<number>;
        /**
         * The maximum size of each `T::ExposurePage`.
         *
         * An `ExposurePage` is weakly bounded to a maximum of `MaxExposurePageSize`
         * nominators.
         *
         * For older non-paged exposure, a reward payout was restricted to the top
         * `MaxExposurePageSize` nominators. This is to limit the i/o cost for the
         * nominator payout.
         *
         * Note: `MaxExposurePageSize` is used to bound `ClaimedRewards` and is unsafe to reduce
         * without handling it in a migration.
         */
        MaxExposurePageSize: PlainDescriptor<number>;
        /**
         * The maximum number of `unlocking` chunks a [`StakingLedger`] can
         * have. Effectively determines how many unique eras a staker may be
         * unbonding in.
         *
         * Note: `MaxUnlockingChunks` is used as the upper bound for the
         * `BoundedVec` item `StakingLedger.unlocking`. Setting this value
         * lower than the existing value can lead to inconsistencies in the
         * `StakingLedger` and will need to be handled properly in a runtime
         * migration. The test `reducing_max_unlocking_chunks_abrupt` shows
         * this effect.
         */
        MaxUnlockingChunks: PlainDescriptor<number>;
    };
    Treasury: {
        /**
         * Period between successive spends.
         */
        SpendPeriod: PlainDescriptor<bigint>;
        /**
         * Percentage of spare funds (if any) that are burnt per spend period.
         */
        Burn: PlainDescriptor<number>;
        /**
         * The treasury's pallet id, used for deriving its sovereign account ID.
         */
        PalletId: PlainDescriptor<FixedSizeBinary<8>>;
        /**
         * The maximum number of approvals that can wait in the spending queue.
         *
         * NOTE: This parameter is also used within the Bounties Pallet extension if enabled.
         */
        MaxApprovals: PlainDescriptor<number>;
        /**
         * The period during which an approved treasury spend has to be claimed.
         */
        PayoutPeriod: PlainDescriptor<bigint>;
    };
    Bounties: {
        /**
         * The amount held on deposit for placing a bounty proposal.
         */
        BountyDepositBase: PlainDescriptor<bigint>;
        /**
         * The delay period for which a bounty beneficiary need to wait before claim the payout.
         */
        BountyDepositPayoutDelay: PlainDescriptor<bigint>;
        /**
         * Bounty duration in blocks.
         */
        BountyUpdatePeriod: PlainDescriptor<bigint>;
        /**
         * The curator deposit is calculated as a percentage of the curator fee.
         *
         * This deposit has optional upper and lower bounds with `CuratorDepositMax` and
         * `CuratorDepositMin`.
         */
        CuratorDepositMultiplier: PlainDescriptor<number>;
        /**
         * Maximum amount of funds that should be placed in a deposit for making a proposal.
         */
        CuratorDepositMax: PlainDescriptor<Anonymize<I35p85j063s0il>>;
        /**
         * Minimum amount of funds that should be placed in a deposit for making a proposal.
         */
        CuratorDepositMin: PlainDescriptor<Anonymize<I35p85j063s0il>>;
        /**
         * Minimum value for a bounty.
         */
        BountyValueMinimum: PlainDescriptor<bigint>;
        /**
         * The amount held on deposit per byte within the tip report reason or bounty description.
         */
        DataDepositPerByte: PlainDescriptor<bigint>;
        /**
         * Maximum acceptable reason length.
         *
         * Benchmarks depend on this value, be sure to update weights file when changing this value
         */
        MaximumReasonLength: PlainDescriptor<number>;
    };
    ChildBounties: {
        /**
         * Maximum number of child bounties that can be added to a parent bounty.
         */
        MaxActiveChildBountyCount: PlainDescriptor<number>;
        /**
         * Minimum value for a child-bounty.
         */
        ChildBountyValueMinimum: PlainDescriptor<bigint>;
    };
    BagsList: {
        /**
         * The list of thresholds separating the various bags.
         *
         * Ids are separated into unsorted bags according to their score. This specifies the
         * thresholds separating the bags. An id's bag is the largest bag for which the id's score
         * is less than or equal to its upper threshold.
         *
         * When ids are iterated, higher bags are iterated completely before lower bags. This means
         * that iteration is _semi-sorted_: ids of higher score tend to come before ids of lower
         * score, but peer ids within a particular bag are sorted in insertion order.
         *
         * # Expressing the constant
         *
         * This constant must be sorted in strictly increasing order. Duplicate items are not
         * permitted.
         *
         * There is an implied upper limit of `Score::MAX`; that value does not need to be
         * specified within the bag. For any two threshold lists, if one ends with
         * `Score::MAX`, the other one does not, and they are otherwise equal, the two
         * lists will behave identically.
         *
         * # Calculation
         *
         * It is recommended to generate the set of thresholds in a geometric series, such that
         * there exists some constant ratio such that `threshold[k + 1] == (threshold[k] *
         * constant_ratio).max(threshold[k] + 1)` for all `k`.
         *
         * The helpers in the `/utils/frame/generate-bags` module can simplify this calculation.
         *
         * # Examples
         *
         * - If `BagThresholds::get().is_empty()`, then all ids are put into the same bag, and
         * iteration is strictly in insertion order.
         * - If `BagThresholds::get().len() == 64`, and the thresholds are determined according to
         * the procedure given above, then the constant ratio is equal to 2.
         * - If `BagThresholds::get().len() == 200`, and the thresholds are determined according to
         * the procedure given above, then the constant ratio is approximately equal to 1.248.
         * - If the threshold list begins `[1, 2, 3, ...]`, then an id with score 0 or 1 will fall
         * into bag 0, an id with score 2 will fall into bag 1, etc.
         *
         * # Migration
         *
         * In the event that this list ever changes, a copy of the old bags list must be retained.
         * With that `List::migrate` can be called, which will perform the appropriate migration.
         */
        BagThresholds: PlainDescriptor<Anonymize<Iafqnechp3omqg>>;
    };
    NominationPools: {
        /**
         * The nomination pool's pallet id.
         */
        PalletId: PlainDescriptor<FixedSizeBinary<8>>;
        /**
         * The maximum pool points-to-balance ratio that an `open` pool can have.
         *
         * This is important in the event slashing takes place and the pool's points-to-balance
         * ratio becomes disproportional.
         *
         * Moreover, this relates to the `RewardCounter` type as well, as the arithmetic operations
         * are a function of number of points, and by setting this value to e.g. 10, you ensure
         * that the total number of points in the system are at most 10 times the total_issuance of
         * the chain, in the absolute worse case.
         *
         * For a value of 10, the threshold would be a pool points-to-balance ratio of 10:1.
         * Such a scenario would also be the equivalent of the pool being 90% slashed.
         */
        MaxPointsToBalance: PlainDescriptor<number>;
        /**
         * The maximum number of simultaneous unbonding chunks that can exist per member.
         */
        MaxUnbonding: PlainDescriptor<number>;
    };
    Scheduler: {
        /**
         * The maximum weight that may be scheduled per block for any dispatchables.
         */
        MaximumWeight: PlainDescriptor<Anonymize<I4q39t5hn830vp>>;
        /**
         * The maximum number of scheduled calls in the queue for a single block.
         *
         * NOTE:
         * + Dependent pallets' benchmarks might require a higher limit for the setting. Set a
         * higher limit under `runtime-benchmarks` feature.
         */
        MaxScheduledPerBlock: PlainDescriptor<number>;
    };
    TxPause: {
        /**
         * Maximum length for pallet name and call name SCALE encoded string names.
         *
         * TOO LONG NAMES WILL BE TREATED AS PAUSED.
         */
        MaxNameLen: PlainDescriptor<number>;
    };
    ImOnline: {
        /**
         * A configuration for base priority of unsigned transactions.
         *
         * This is exposed so that it can be tuned for particular runtime, when
         * multiple pallets send unsigned transactions.
         */
        UnsignedPriority: PlainDescriptor<bigint>;
    };
    Identity: {
        /**
         * The amount held on deposit for a registered identity.
         */
        BasicDeposit: PlainDescriptor<bigint>;
        /**
         * The amount held on deposit per encoded byte for a registered identity.
         */
        ByteDeposit: PlainDescriptor<bigint>;
        /**
         * The amount held on deposit for a registered subaccount. This should account for the fact
         * that one storage item's value will increase by the size of an account ID, and there will
         * be another trie item whose value is the size of an account ID plus 32 bytes.
         */
        SubAccountDeposit: PlainDescriptor<bigint>;
        /**
         * The maximum number of sub-accounts allowed per identified account.
         */
        MaxSubAccounts: PlainDescriptor<number>;
        /**
         * Maximum number of registrars allowed in the system. Needed to bound the complexity
         * of, e.g., updating judgements.
         */
        MaxRegistrars: PlainDescriptor<number>;
        /**
         * The number of blocks within which a username grant must be accepted.
         */
        PendingUsernameExpiration: PlainDescriptor<bigint>;
        /**
         * The maximum length of a suffix.
         */
        MaxSuffixLength: PlainDescriptor<number>;
        /**
         * The maximum length of a username, including its suffix and any system-added delimiters.
         */
        MaxUsernameLength: PlainDescriptor<number>;
    };
    Utility: {
        /**
         * The limit on the number of batched calls.
         */
        batched_calls_limit: PlainDescriptor<number>;
    };
    Multisig: {
        /**
         * The base amount of currency needed to reserve for creating a multisig execution or to
         * store a dispatch call for later.
         *
         * This is held for an additional storage item whose value size is
         * `4 + sizeof((BlockNumber, Balance, AccountId))` bytes and whose key size is
         * `32 + sizeof(AccountId)` bytes.
         */
        DepositBase: PlainDescriptor<bigint>;
        /**
         * The amount of currency needed per unit threshold when creating a multisig execution.
         *
         * This is held for adding 32 bytes more into a pre-existing storage value.
         */
        DepositFactor: PlainDescriptor<bigint>;
        /**
         * The maximum amount of signatories allowed in the multisig.
         */
        MaxSignatories: PlainDescriptor<number>;
    };
    Proxy: {
        /**
         * The base amount of currency needed to reserve for creating a proxy.
         *
         * This is held for an additional storage item whose value size is
         * `sizeof(Balance)` bytes and whose key size is `sizeof(AccountId)` bytes.
         */
        ProxyDepositBase: PlainDescriptor<bigint>;
        /**
         * The amount of currency needed per proxy added.
         *
         * This is held for adding 32 bytes plus an instance of `ProxyType` more into a
         * pre-existing storage value. Thus, when configuring `ProxyDepositFactor` one should take
         * into account `32 + proxy_type.encode().len()` bytes of data.
         */
        ProxyDepositFactor: PlainDescriptor<bigint>;
        /**
         * The maximum amount of proxies allowed for a single account.
         */
        MaxProxies: PlainDescriptor<number>;
        /**
         * The maximum amount of time-delayed announcements that are allowed to be pending.
         */
        MaxPending: PlainDescriptor<number>;
        /**
         * The base amount of currency needed to reserve for creating an announcement.
         *
         * This is held when a new storage item holding a `Balance` is created (typically 16
         * bytes).
         */
        AnnouncementDepositBase: PlainDescriptor<bigint>;
        /**
         * The amount of currency needed per announcement made.
         *
         * This is held for adding an `AccountId`, `Hash` and `BlockNumber` (typically 68 bytes)
         * into a pre-existing storage value.
         */
        AnnouncementDepositFactor: PlainDescriptor<bigint>;
    };
    Registration: {
        /**
         * The minimum amount that must be staked by a miner
         */
        MinerStakeThreshold: PlainDescriptor<number>;
        /**
        
         */
        ChainDecimals: PlainDescriptor<number>;
        /**
         * The pallet's id, used for deriving its sovereign account ID.
         */
        PalletId: PlainDescriptor<FixedSizeBinary<8>>;
        /**
         * Initial fixed fee for each node type
         */
        StorageMinerInitialFee: PlainDescriptor<bigint>;
        /**
        
         */
        ValidatorInitialFee: PlainDescriptor<bigint>;
        /**
        
         */
        ComputeMinerInitialFee: PlainDescriptor<bigint>;
        /**
        
         */
        GpuMinerInitialFee: PlainDescriptor<bigint>;
        /**
        
         */
        StorageMiners3InitialFee: PlainDescriptor<bigint>;
        /**
        
         */
        BlocksPerDay: PlainDescriptor<number>;
        /**
        
         */
        NodeCooldownPeriod: PlainDescriptor<bigint>;
        /**
        
         */
        MaxDeregRequestsPerPeriod: PlainDescriptor<number>;
        /**
        
         */
        ConsensusThreshold: PlainDescriptor<number>;
        /**
        
         */
        EpochDuration: PlainDescriptor<number>;
        /**
        
         */
        ReportRequestsClearInterval: PlainDescriptor<number>;
    };
    ExecutionUnit: {
        /**
        
         */
        LocalRpcUrl: PlainDescriptor<string>;
        /**
        
         */
        SystemInfoRpcMethod: PlainDescriptor<string>;
        /**
        
         */
        GetReadProofRpcMethod: PlainDescriptor<string>;
        /**
        
         */
        SystemHealthRpcMethod: PlainDescriptor<string>;
        /**
        
         */
        UnregistrationBuffer: PlainDescriptor<number>;
        /**
        
         */
        MaxOffchainRequestsPerPeriod: PlainDescriptor<number>;
        /**
        
         */
        RequestsClearInterval: PlainDescriptor<number>;
        /**
        
         */
        MaxOffchainHardwareSubmitRequestsPerPeriod: PlainDescriptor<number>;
        /**
        
         */
        HardwareSubmitRequestsClearInterval: PlainDescriptor<number>;
        /**
        
         */
        IpfsServiceUrl: PlainDescriptor<string>;
        /**
        
         */
        LocalDefaultSpecVersion: PlainDescriptor<number>;
        /**
        
         */
        LocalDefaultGenesisHash: PlainDescriptor<string>;
        /**
        
         */
        ConsensusThreshold: PlainDescriptor<number>;
        /**
        
         */
        ConsensusSimilarityThreshold: PlainDescriptor<number>;
        /**
        
         */
        EpochDuration: PlainDescriptor<number>;
        /**
         * The block interval at which to update miner reputations
         */
        ReputationUpdateInterval: PlainDescriptor<number>;
    };
    Metagraph: {
        /**
        
         */
        FinneyUrl: PlainDescriptor<string>;
        /**
        
         */
        UidsStorageKey: PlainDescriptor<string>;
        /**
        
         */
        DividendsStorageKey: PlainDescriptor<string>;
        /**
        
         */
        UidsSubmissionInterval: PlainDescriptor<number>;
    };
    Marketplace: {
        /**
         * Minimum subscription duration in blocks
         */
        MinSubscriptionBlocks: PlainDescriptor<bigint>;
        /**
         * Maximum active subscriptions per user
         */
        MaxActiveSubscriptions: PlainDescriptor<number>;
        /**
         * The pallet's id, used for deriving its sovereign account ID.
         */
        PalletId: PlainDescriptor<FixedSizeBinary<8>>;
        /**
        
         */
        BlockDurationMillis: PlainDescriptor<bigint>;
        /**
        
         */
        BlocksPerHour: PlainDescriptor<number>;
        /**
        
         */
        BlocksPerEra: PlainDescriptor<number>;
        /**
        
         */
        StorageGracePeriod: PlainDescriptor<number>;
        /**
        
         */
        ComputeGracePeriod: PlainDescriptor<number>;
        /**
        
         */
        MaxRequestsPerBlock: PlainDescriptor<number>;
    };
    Bittensor: {
        /**
        
         */
        FinneyRpcUrl: PlainDescriptor<string>;
        /**
        
         */
        VersionKeyStorageKey: PlainDescriptor<string>;
        /**
        
         */
        BittensorCallSubmission: PlainDescriptor<number>;
        /**
        
         */
        NetUid: PlainDescriptor<number>;
        /**
        
         */
        Versionkey: PlainDescriptor<number>;
        /**
        
         */
        DefaultSpecVersion: PlainDescriptor<number>;
        /**
        
         */
        DefaultGenesisHash: PlainDescriptor<string>;
    };
    SubAccount: {
        /**
        
         */
        StringLimit: PlainDescriptor<number>;
        /**
        
         */
        MaxSubAccountsLimit: PlainDescriptor<number>;
    };
    Notifications: {
        /**
         * Cooldown period in blocks
         */
        CooldownPeriod: PlainDescriptor<number>;
    };
    Utils: {
        /**
        
         */
        LocalRpcUrl: PlainDescriptor<string>;
        /**
        
         */
        RpcMethod: PlainDescriptor<string>;
    };
    RankingStorage: {
        /**
         * The PalletId for this pallet
         */
        PalletId: PlainDescriptor<FixedSizeBinary<8>>;
        /**
         * Percentage of total rewards allocated to compute nodes (0-100)
         */
        ComputeNodesRewardPercentage: PlainDescriptor<number>;
        /**
         * Percentage of total rewards allocated to miner nodes (0-100)
         */
        MinerNodesRewardPercentage: PlainDescriptor<number>;
        /**
         * Percentage of total rewards allocated to miner nodes (0-100)
         */
        InstanceID: PlainDescriptor<number>;
        /**
        
         */
        BlocksPerEra: PlainDescriptor<number>;
        /**
        
         */
        LocalDefaultSpecVersion: PlainDescriptor<number>;
        /**
        
         */
        LocalDefaultGenesisHash: PlainDescriptor<string>;
        /**
        
         */
        LocalRpcUrl: PlainDescriptor<string>;
    };
    RankingCompute: {
        /**
         * The PalletId for this pallet
         */
        PalletId: PlainDescriptor<FixedSizeBinary<8>>;
        /**
         * Percentage of total rewards allocated to compute nodes (0-100)
         */
        ComputeNodesRewardPercentage: PlainDescriptor<number>;
        /**
         * Percentage of total rewards allocated to miner nodes (0-100)
         */
        MinerNodesRewardPercentage: PlainDescriptor<number>;
        /**
         * Percentage of total rewards allocated to miner nodes (0-100)
         */
        InstanceID: PlainDescriptor<number>;
        /**
        
         */
        BlocksPerEra: PlainDescriptor<number>;
        /**
        
         */
        LocalDefaultSpecVersion: PlainDescriptor<number>;
        /**
        
         */
        LocalDefaultGenesisHash: PlainDescriptor<string>;
        /**
        
         */
        LocalRpcUrl: PlainDescriptor<string>;
    };
    RankingValidators: {
        /**
         * The PalletId for this pallet
         */
        PalletId: PlainDescriptor<FixedSizeBinary<8>>;
        /**
         * Percentage of total rewards allocated to compute nodes (0-100)
         */
        ComputeNodesRewardPercentage: PlainDescriptor<number>;
        /**
         * Percentage of total rewards allocated to miner nodes (0-100)
         */
        MinerNodesRewardPercentage: PlainDescriptor<number>;
        /**
         * Percentage of total rewards allocated to miner nodes (0-100)
         */
        InstanceID: PlainDescriptor<number>;
        /**
        
         */
        BlocksPerEra: PlainDescriptor<number>;
        /**
        
         */
        LocalDefaultSpecVersion: PlainDescriptor<number>;
        /**
        
         */
        LocalDefaultGenesisHash: PlainDescriptor<string>;
        /**
        
         */
        LocalRpcUrl: PlainDescriptor<string>;
    };
    Credits: {
        /**
        
         */
        RefferallCoolDOwnPeriod: PlainDescriptor<number>;
    };
    ContainerRegistry: {
        /**
         * Maximum length for various metadata fields
         */
        MaxLength: PlainDescriptor<number>;
    };
    AlphaBridge: {
        /**
         * The pallet's id, used for deriving its sovereign account ID.
         */
        PalletId: PlainDescriptor<FixedSizeBinary<8>>;
    };
    IpfsPallet: {
        /**
        
         */
        IPFSBaseUrl: PlainDescriptor<string>;
        /**
        
         */
        GarbageCollectorInterval: PlainDescriptor<number>;
        /**
        
         */
        PinPinningInterval: PlainDescriptor<number>;
        /**
        
         */
        MaxOffchainRequestsPerPeriod: PlainDescriptor<number>;
        /**
        
         */
        RequestsClearInterval: PlainDescriptor<number>;
        /**
         * The duration of an epoch in blocks.
         */
        EpochPeriod: PlainDescriptor<bigint>;
    };
    Arion: {
        /**
         * Enforce that miners in submitted CRUSH maps must be present in this pallet’s registry.
         * Recommended: `true` once validator fully relies on on-chain registration.
         */
        EnforceRegisteredMinersInMap: PlainDescriptor<boolean>;
        /**
         * Max number of miners allowed in a single epoch map.
         */
        MaxMiners: PlainDescriptor<number>;
        /**
         * Max bytes for `endpoint`.
         */
        MaxEndpointLen: PlainDescriptor<number>;
        /**
         * Max bytes for `http_addr`.
         */
        MaxHttpAddrLen: PlainDescriptor<number>;
        /**
         * Max number of miner stats updates per submission.
         */
        MaxStatsUpdates: PlainDescriptor<number>;
        /**
         * Max number of attestations per submission.
         */
        MaxAttestations: PlainDescriptor<number>;
        /**
         * Max bytes for shard hash in attestation.
         */
        MaxShardHashLen: PlainDescriptor<number>;
        /**
         * Max bytes for warden pubkey in attestation.
         */
        MaxWardenPubkeyLen: PlainDescriptor<number>;
        /**
         * Max bytes for signature in attestation.
         */
        MaxSignatureLen: PlainDescriptor<number>;
        /**
         * Max bytes for Merkle proof signature hash in attestation.
         */
        MaxMerkleProofLen: PlainDescriptor<number>;
        /**
         * Max bytes for warden ID in attestation.
         */
        MaxWardenIdLen: PlainDescriptor<number>;
        /**
         * Max bytes for content hash in attestation commitment (BLAKE3 = 32 bytes).
         */
        MaxContentHashLen: PlainDescriptor<number>;
        /**
         * Number of attestation buckets to retain before pruning.
         * Older buckets can be pruned to prevent unbounded storage growth.
         * Default recommendation: 1000 buckets (~7 days at 300 blocks/bucket, 6s blocks)
         */
        AttestationRetentionBuckets: PlainDescriptor<number>;
        /**
         * Max distinct families that can ever claim their first “free” child slot.
         * (You mentioned 256).
         */
        MaxFamilies: PlainDescriptor<number>;
        /**
         * Max total number of active children across all families.
         * (You mentioned ~2K).
         */
        MaxChildrenTotal: PlainDescriptor<number>;
        /**
         * Max number of active children within one family.
         */
        MaxChildrenPerFamily: PlainDescriptor<number>;
        /**
         * Base deposit used to initialize / floor the global deposit curve.
         *
         * NOTE: This acts as a default. The actual runtime-configurable value is stored
         * in `BaseChildDepositValue` and can be changed via the sudo/admin extrinsic.
         */
        BaseChildDeposit: PlainDescriptor<bigint>;
        /**
         * Number of blocks after which the global next deposit halves (lazy decay).
         * Use ~24h: 24*60*60/6 = 14_400 blocks at 6s.
         */
        GlobalDepositHalvingPeriodBlocks: PlainDescriptor<bigint>;
        /**
         * Cooldown after deregistration: child/node cannot be re-registered until this passes.
         */
        UnregisterCooldownBlocks: PlainDescriptor<bigint>;
        /**
         * Unbonding period: deposit stays reserved until this passes, then `claim_unbonded` releases it.
         */
        UnbondingPeriodBlocks: PlainDescriptor<bigint>;
        /**
         * Max number of node-weight updates per submission.
         */
        MaxNodeWeightUpdates: PlainDescriptor<number>;
        /**
         * Max per-node weight (caps what can be stored / counted).
         */
        MaxNodeWeight: PlainDescriptor<number>;
        /**
         * Max per-family weight (caps what can be stored / submitted to external systems like Bittensor).
         */
        MaxFamilyWeight: PlainDescriptor<number>;
        /**
         * How many top node weights to count per family (anti “just add infinite children”).
         */
        FamilyTopN: PlainDescriptor<number>;
        /**
         * Decay factor per rank (permille). Example: 800 → each next node contributes 0.8x the previous.
         */
        FamilyRankDecayPermille: PlainDescriptor<number>;
        /**
         * EMA alpha (permille) for smoothing family weight over time.
         * Example: 300 → 30% new, 70% previous.
         */
        FamilyWeightEmaAlphaPermille: PlainDescriptor<number>;
        /**
         * Max change allowed per bucket for family weights (safety against transient spikes).
         */
        MaxFamilyWeightDeltaPerBucket: PlainDescriptor<number>;
        /**
         * Newcomer grace buckets: apply a small floor (only if computed weight > 0) for early buckets.
         */
        NewcomerGraceBuckets: PlainDescriptor<number>;
        /**
         * Newcomer floor weight (applied during grace window if computed weight > 0).
         */
        NewcomerFloorWeight: PlainDescriptor<number>;
        /**
         * Bandwidth contribution weight (permille). Recommended: 700..900.
         */
        NodeBandwidthWeightPermille: PlainDescriptor<number>;
        /**
         * Storage (stored bytes) contribution weight (permille). Recommended: 100..300.
         */
        NodeStorageWeightPermille: PlainDescriptor<number>;
        /**
         * Scale applied after combining log-scores to map into u16 range. Recommended: 512.
         */
        NodeScoreScale: PlainDescriptor<number>;
        /**
         * Strike penalty per strike (in u16 weight units).
         */
        StrikePenalty: PlainDescriptor<number>;
        /**
         * Integrity failure penalty per fail (in u16 weight units).
         */
        IntegrityFailPenalty: PlainDescriptor<number>;
    };
};
type IViewFns = {};
type IRuntimeCalls = {
    /**
     * The `Core` runtime api that every Substrate runtime needs to implement.
     */
    Core: {
        /**
         * Returns the version of the runtime.
         */
        version: RuntimeDescriptor<[], Anonymize<Ic6nglu2db2c36>>;
        /**
         * Execute the given block.
         */
        execute_block: RuntimeDescriptor<[block: Anonymize<I1e13lcoj2ijct>], undefined>;
        /**
         * Initialize a block with the given header and return the runtime executive mode.
         */
        initialize_block: RuntimeDescriptor<[header: Anonymize<Idcpi3jpt0c03v>], Anonymize<I2v50gu3s1aqk6>>;
    };
    /**
     * The `Metadata` api trait that returns metadata for the runtime.
     */
    Metadata: {
        /**
         * Returns the metadata of a runtime.
         */
        metadata: RuntimeDescriptor<[], Binary>;
        /**
         * Returns the metadata at a given version.
         *
         * If the given `version` isn't supported, this will return `None`.
         * Use [`Self::metadata_versions`] to find out about supported metadata version of the runtime.
         */
        metadata_at_version: RuntimeDescriptor<[version: number], Anonymize<Iabpgqcjikia83>>;
        /**
         * Returns the supported metadata versions.
         *
         * This can be used to call `metadata_at_version`.
         */
        metadata_versions: RuntimeDescriptor<[], Anonymize<Icgljjb6j82uhn>>;
    };
    /**
     * The `BlockBuilder` api trait that provides the required functionality for building a block.
     */
    BlockBuilder: {
        /**
         * Apply the given extrinsic.
         *
         * Returns an inclusion outcome which specifies if this extrinsic is included in
         * this block or not.
         */
        apply_extrinsic: RuntimeDescriptor<[extrinsic: Binary], Anonymize<I4383lq801834t>>;
        /**
         * Finish the current block.
         */
        finalize_block: RuntimeDescriptor<[], Anonymize<Idcpi3jpt0c03v>>;
        /**
         * Generate inherent extrinsics. The inherent data will vary from chain to chain.
         */
        inherent_extrinsics: RuntimeDescriptor<[inherent: Anonymize<If7uv525tdvv7a>], Anonymize<Itom7fk49o0c9>>;
        /**
         * Check that the inherents are valid. The inherent data will vary from chain to chain.
         */
        check_inherents: RuntimeDescriptor<[block: Anonymize<I1e13lcoj2ijct>, data: Anonymize<If7uv525tdvv7a>], Anonymize<I2an1fs2eiebjp>>;
    };
    /**
     * API necessary for Ethereum-compatibility layer.
     */
    EthereumRuntimeRPCApi: {
        /**
         * Returns runtime defined pallet_evm::ChainId.
         */
        chain_id: RuntimeDescriptor<[], bigint>;
        /**
         * Returns pallet_evm::Accounts by address.
         */
        account_basic: RuntimeDescriptor<[address: FixedSizeBinary<20>], Anonymize<If08sfhqn8ujfr>>;
        /**
         * Returns FixedGasPrice::min_gas_price
         */
        gas_price: RuntimeDescriptor<[], Anonymize<I4totqt881mlti>>;
        /**
         * For a given account address, returns pallet_evm::AccountCodes.
         */
        account_code_at: RuntimeDescriptor<[address: FixedSizeBinary<20>], Binary>;
        /**
         * Returns the converted FindAuthor::find_author authority id.
         */
        author: RuntimeDescriptor<[], FixedSizeBinary<20>>;
        /**
         * For a given account address and index, returns pallet_evm::AccountStorages.
         */
        storage_at: RuntimeDescriptor<[address: FixedSizeBinary<20>, index: Anonymize<I4totqt881mlti>], FixedSizeBinary<32>>;
        /**
        
         */
        call: RuntimeDescriptor<[from: FixedSizeBinary<20>, to: FixedSizeBinary<20>, data: Binary, value: Anonymize<I4totqt881mlti>, gas_limit: Anonymize<I4totqt881mlti>, max_fee_per_gas: Anonymize<Ic4rgfgksgmm3e>, max_priority_fee_per_gas: Anonymize<Ic4rgfgksgmm3e>, nonce: Anonymize<Ic4rgfgksgmm3e>, estimate: boolean, access_list: Anonymize<I3dj14b7k3rkm5>], Anonymize<I8gq452h0p0ftu>>;
        /**
        
         */
        create: RuntimeDescriptor<[from: FixedSizeBinary<20>, data: Binary, value: Anonymize<I4totqt881mlti>, gas_limit: Anonymize<I4totqt881mlti>, max_fee_per_gas: Anonymize<Ic4rgfgksgmm3e>, max_priority_fee_per_gas: Anonymize<Ic4rgfgksgmm3e>, nonce: Anonymize<Ic4rgfgksgmm3e>, estimate: boolean, access_list: Anonymize<I3dj14b7k3rkm5>], Anonymize<If6glui021su7n>>;
        /**
         * Return the current block.
         */
        current_block: RuntimeDescriptor<[], Anonymize<Ifogockjiq4b3>>;
        /**
         * Return the current receipt.
         */
        current_receipts: RuntimeDescriptor<[], Anonymize<I2r0n4gcrs974b>>;
        /**
         * Return the current transaction status.
         */
        current_transaction_statuses: RuntimeDescriptor<[], Anonymize<Ie6kgk6f04rsvk>>;
        /**
        
         */
        current_all: RuntimeDescriptor<[], Anonymize<Ibkook56hopvp8>>;
        /**
         * Receives a `Vec<OpaqueExtrinsic>` and filters all the ethereum transactions.
         */
        extrinsic_filter: RuntimeDescriptor<[xts: Anonymize<Itom7fk49o0c9>], Anonymize<I1fl9qh2r1hf29>>;
        /**
         * Return the elasticity multiplier.
         */
        elasticity: RuntimeDescriptor<[], Anonymize<I4arjljr6dpflb>>;
        /**
         * Used to determine if gas limit multiplier for non-transactional calls (eth_call/estimateGas)
         * is supported.
         */
        gas_limit_multiplier_support: RuntimeDescriptor<[], undefined>;
        /**
         * Return the pending block.
         */
        pending_block: RuntimeDescriptor<[xts: Anonymize<Itom7fk49o0c9>], Anonymize<I45rl58hfs7m0h>>;
        /**
         * Initialize the pending block.
         * The behavior should be the same as the runtime api Core_initialize_block but
         * for a "pending" block.
         * If your project don't need to have a different behavior to initialize "pending" blocks,
         * you can copy your Core_initialize_block implementation.
         */
        initialize_pending_block: RuntimeDescriptor<[header: Anonymize<Idcpi3jpt0c03v>], undefined>;
    };
    /**
    
     */
    ConvertTransactionRuntimeApi: {
        /**
        
         */
        convert_transaction: RuntimeDescriptor<[transaction: Anonymize<I6fr2mqud652ga>], Binary>;
    };
    /**
     * The `TaggedTransactionQueue` api trait for interfering with the transaction queue.
     */
    TaggedTransactionQueue: {
        /**
         * Validate the transaction.
         *
         * This method is invoked by the transaction pool to learn details about given transaction.
         * The implementation should make sure to verify the correctness of the transaction
         * against current state. The given `block_hash` corresponds to the hash of the block
         * that is used as current state.
         *
         * Note that this call may be performed by the pool multiple times and transactions
         * might be verified in any possible order.
         */
        validate_transaction: RuntimeDescriptor<[source: TransactionValidityTransactionSource, tx: Binary, block_hash: FixedSizeBinary<32>], Anonymize<Iajbob6uln5jct>>;
    };
    /**
     * The offchain worker api.
     */
    OffchainWorkerApi: {
        /**
         * Starts the off-chain task for given block header.
         */
        offchain_worker: RuntimeDescriptor<[header: Anonymize<Idcpi3jpt0c03v>], undefined>;
    };
    /**
     * Session keys runtime api.
     */
    SessionKeys: {
        /**
         * Generate a set of session keys with optionally using the given seed.
         * The keys should be stored within the keystore exposed via runtime
         * externalities.
         *
         * The seed needs to be a valid `utf8` string.
         *
         * Returns the concatenated SCALE encoded public keys.
         */
        generate_session_keys: RuntimeDescriptor<[seed: Anonymize<Iabpgqcjikia83>], Binary>;
        /**
         * Decode the given public session keys.
         *
         * Returns the list of public raw public keys + key type.
         */
        decode_session_keys: RuntimeDescriptor<[encoded: Binary], Anonymize<Icerf8h8pdu8ss>>;
    };
    /**
     * API necessary for block authorship with BABE.
     */
    BabeApi: {
        /**
         * Return the configuration for BABE.
         */
        configuration: RuntimeDescriptor<[], Anonymize<Iems84l8lk2v0c>>;
        /**
         * Returns the slot that started the current epoch.
         */
        current_epoch_start: RuntimeDescriptor<[], bigint>;
        /**
         * Returns information regarding the current epoch.
         */
        current_epoch: RuntimeDescriptor<[], Anonymize<I1r5ke30ueqo0r>>;
        /**
         * Returns information regarding the next epoch (which was already
         * previously announced).
         */
        next_epoch: RuntimeDescriptor<[], Anonymize<I1r5ke30ueqo0r>>;
        /**
         * Generates a proof of key ownership for the given authority in the
         * current epoch. An example usage of this module is coupled with the
         * session historical module to prove that a given authority key is
         * tied to a given staking identity during a specific session. Proofs
         * of key ownership are necessary for submitting equivocation reports.
         * NOTE: even though the API takes a `slot` as parameter the current
         * implementations ignores this parameter and instead relies on this
         * method being called at the correct block height, i.e. any point at
         * which the epoch for the given slot is live on-chain. Future
         * implementations will instead use indexed data through an offchain
         * worker, not requiring older states to be available.
         */
        generate_key_ownership_proof: RuntimeDescriptor<[slot: bigint, authority_id: FixedSizeBinary<32>], Anonymize<Iabpgqcjikia83>>;
        /**
         * Submits an unsigned extrinsic to report an equivocation. The caller
         * must provide the equivocation proof and a key ownership proof
         * (should be obtained using `generate_key_ownership_proof`). The
         * extrinsic will be unsigned and should only be accepted for local
         * authorship (not to be broadcast to the network). This method returns
         * `None` when creation of the extrinsic fails, e.g. if equivocation
         * reporting is disabled for the given runtime (i.e. this method is
         * hardcoded to return `None`). Only useful in an offchain context.
         */
        submit_report_equivocation_unsigned_extrinsic: RuntimeDescriptor<[equivocation_proof: Anonymize<I55620scbn6g1k>, key_owner_proof: Binary], boolean>;
    };
    /**
     * The API to query account nonce.
     */
    AccountNonceApi: {
        /**
         * Get current account nonce of given `AccountId`.
         */
        account_nonce: RuntimeDescriptor<[account: SS58String], number>;
    };
    /**
    
     */
    TransactionPaymentApi: {
        /**
        
         */
        query_info: RuntimeDescriptor<[uxt: Binary, len: number], Anonymize<I6spmpef2c7svf>>;
        /**
        
         */
        query_fee_details: RuntimeDescriptor<[uxt: Binary, len: number], Anonymize<Iei2mvq0mjvt81>>;
        /**
        
         */
        query_weight_to_fee: RuntimeDescriptor<[weight: Anonymize<I4q39t5hn830vp>], bigint>;
        /**
        
         */
        query_length_to_fee: RuntimeDescriptor<[length: number], bigint>;
    };
    /**
     * APIs for integrating the GRANDPA finality gadget into runtimes.
     * This should be implemented on the runtime side.
     *
     * This is primarily used for negotiating authority-set changes for the
     * gadget. GRANDPA uses a signaling model of changing authority sets:
     * changes should be signaled with a delay of N blocks, and then automatically
     * applied in the runtime after those N blocks have passed.
     *
     * The consensus protocol will coordinate the handoff externally.
     */
    GrandpaApi: {
        /**
         * Get the current GRANDPA authorities and weights. This should not change except
         * for when changes are scheduled and the corresponding delay has passed.
         *
         * When called at block B, it will return the set of authorities that should be
         * used to finalize descendants of this block (B+1, B+2, ...). The block B itself
         * is finalized by the authorities from block B-1.
         */
        grandpa_authorities: RuntimeDescriptor<[], Anonymize<I3geksg000c171>>;
        /**
         * Submits an unsigned extrinsic to report an equivocation. The caller
         * must provide the equivocation proof and a key ownership proof
         * (should be obtained using `generate_key_ownership_proof`). The
         * extrinsic will be unsigned and should only be accepted for local
         * authorship (not to be broadcast to the network). This method returns
         * `None` when creation of the extrinsic fails, e.g. if equivocation
         * reporting is disabled for the given runtime (i.e. this method is
         * hardcoded to return `None`). Only useful in an offchain context.
         */
        submit_report_equivocation_unsigned_extrinsic: RuntimeDescriptor<[equivocation_proof: Anonymize<Ifh2vvcsf9090p>, key_owner_proof: Binary], boolean>;
        /**
         * Generates a proof of key ownership for the given authority in the
         * given set. An example usage of this module is coupled with the
         * session historical module to prove that a given authority key is
         * tied to a given staking identity during a specific session. Proofs
         * of key ownership are necessary for submitting equivocation reports.
         * NOTE: even though the API takes a `set_id` as parameter the current
         * implementations ignore this parameter and instead rely on this
         * method being called at the correct block height, i.e. any point at
         * which the given set id is live on-chain. Future implementations will
         * instead use indexed data through an offchain worker, not requiring
         * older states to be available.
         */
        generate_key_ownership_proof: RuntimeDescriptor<[set_id: bigint, authority_id: FixedSizeBinary<32>], Anonymize<Iabpgqcjikia83>>;
        /**
         * Get current GRANDPA authority set id.
         */
        current_set_id: RuntimeDescriptor<[], bigint>;
    };
    /**
    
     */
    DebugRuntimeApi: {
        /**
        
         */
        trace_transaction: RuntimeDescriptor<[extrinsics: Anonymize<Itom7fk49o0c9>, transaction: Anonymize<I6fr2mqud652ga>, header: Anonymize<Idcpi3jpt0c03v>], Anonymize<I5stn0hvret66s>>;
        /**
        
         */
        trace_block: RuntimeDescriptor<[extrinsics: Anonymize<Itom7fk49o0c9>, known_transactions: Anonymize<Ic5m5lp1oioo8r>, header: Anonymize<Idcpi3jpt0c03v>], Anonymize<I5stn0hvret66s>>;
        /**
        
         */
        trace_call: RuntimeDescriptor<[header: Anonymize<Idcpi3jpt0c03v>, from: FixedSizeBinary<20>, to: FixedSizeBinary<20>, data: Binary, value: Anonymize<I4totqt881mlti>, gas_limit: Anonymize<I4totqt881mlti>, max_fee_per_gas: Anonymize<Ic4rgfgksgmm3e>, max_priority_fee_per_gas: Anonymize<Ic4rgfgksgmm3e>, nonce: Anonymize<Ic4rgfgksgmm3e>, access_list: Anonymize<I3dj14b7k3rkm5>], Anonymize<I5stn0hvret66s>>;
    };
    /**
    
     */
    NodeMetricsRuntimeApi: {
        /**
        
         */
        get_active_nodes_metrics_by_type: RuntimeDescriptor<[node_type: Anonymize<I9ea6lu6bbueo9>], Anonymize<I7qoh20ucjt7ir>>;
        /**
        
         */
        get_total_distributed_rewards_by_node_type: RuntimeDescriptor<[node_type: Anonymize<I9ea6lu6bbueo9>], bigint>;
        /**
        
         */
        get_total_node_rewards: RuntimeDescriptor<[account: SS58String], bigint>;
        /**
        
         */
        get_miners_total_rewards: RuntimeDescriptor<[node_type: Anonymize<I9ea6lu6bbueo9>], Anonymize<Ic42ukvpnbiepo>>;
        /**
        
         */
        get_account_pending_rewards: RuntimeDescriptor<[account: SS58String], Anonymize<Ic42ukvpnbiepo>>;
        /**
        
         */
        get_miners_pending_rewards: RuntimeDescriptor<[node_type: Anonymize<I9ea6lu6bbueo9>], Anonymize<Ic42ukvpnbiepo>>;
        /**
        
         */
        calculate_total_file_size: RuntimeDescriptor<[account: SS58String], bigint>;
        /**
        
         */
        get_user_files: RuntimeDescriptor<[account: SS58String], Anonymize<I9fkvk930p4vn2>>;
        /**
        
         */
        get_node_metrics: RuntimeDescriptor<[node_id: Binary], Anonymize<I9mv67prtv3200>>;
        /**
        
         */
        get_client_ip: RuntimeDescriptor<[client_id: SS58String], Anonymize<Iabpgqcjikia83>>;
        /**
        
         */
        get_hypervisor_ip: RuntimeDescriptor<[hypervisor_id: Binary], Anonymize<Iabpgqcjikia83>>;
        /**
        
         */
        get_vm_ip: RuntimeDescriptor<[vm_id: Binary], Anonymize<Iabpgqcjikia83>>;
        /**
        
         */
        get_storage_miner_ip: RuntimeDescriptor<[miner_id: Binary], Anonymize<Iabpgqcjikia83>>;
        /**
        
         */
        get_miner_info: RuntimeDescriptor<[account_id: SS58String], Anonymize<I7hmn6t6t2ehn9>>;
        /**
        
         */
        get_batches_for_user: RuntimeDescriptor<[account_id: SS58String], Anonymize<Idn8l2092gsjnc>>;
        /**
        
         */
        get_batch_by_id: RuntimeDescriptor<[batch_id: bigint], Anonymize<I7dv09hod9o9ng>>;
        /**
        
         */
        get_free_credits_rpc: RuntimeDescriptor<[account: Anonymize<Ihfphjolmsqq1>], Anonymize<Iba9inugg1atvo>>;
        /**
        
         */
        get_referred_users: RuntimeDescriptor<[account_id: SS58String], Anonymize<Ia2lhg7l2hilo3>>;
        /**
        
         */
        get_referral_rewards: RuntimeDescriptor<[account_id: SS58String], bigint>;
        /**
        
         */
        total_referral_codes: RuntimeDescriptor<[], number>;
        /**
        
         */
        total_referral_rewards: RuntimeDescriptor<[], bigint>;
        /**
        
         */
        get_referral_codes: RuntimeDescriptor<[account_id: SS58String], Anonymize<Itom7fk49o0c9>>;
        /**
        
         */
        total_file_size_fulfilled: RuntimeDescriptor<[account_id: SS58String], bigint>;
    };
    /**
    
     */
    TxPoolRuntimeApi: {
        /**
        
         */
        extrinsic_filter: RuntimeDescriptor<[xt_ready: Anonymize<Itom7fk49o0c9>, xt_future: Anonymize<Itom7fk49o0c9>], Anonymize<I2q8ltoai1r4og>>;
    };
    /**
     * API to interact with RuntimeGenesisConfig for the runtime
     */
    GenesisBuilder: {
        /**
         * Build `RuntimeGenesisConfig` from a JSON blob not using any defaults and store it in the
         * storage.
         *
         * In the case of a FRAME-based runtime, this function deserializes the full `RuntimeGenesisConfig` from the given JSON blob and
         * puts it into the storage. If the provided JSON blob is incorrect or incomplete or the
         * deserialization fails, an error is returned.
         *
         * Please note that provided JSON blob must contain all `RuntimeGenesisConfig` fields, no
         * defaults will be used.
         */
        build_state: RuntimeDescriptor<[json: Binary], Anonymize<Ie9sr1iqcg3cgm>>;
        /**
         * Returns a JSON blob representation of the built-in `RuntimeGenesisConfig` identified by
         * `id`.
         *
         * If `id` is `None` the function returns JSON blob representation of the default
         * `RuntimeGenesisConfig` struct of the runtime. Implementation must provide default
         * `RuntimeGenesisConfig`.
         *
         * Otherwise function returns a JSON representation of the built-in, named
         * `RuntimeGenesisConfig` preset identified by `id`, or `None` if such preset does not
         * exists. Returned `Vec<u8>` contains bytes of JSON blob (patch) which comprises a list of
         * (potentially nested) key-value pairs that are intended for customizing the default
         * runtime genesis config. The patch shall be merged (rfc7386) with the JSON representation
         * of the default `RuntimeGenesisConfig` to create a comprehensive genesis config that can
         * be used in `build_state` method.
         */
        get_preset: RuntimeDescriptor<[id: Anonymize<I1mqgk2tmnn9i2>], Anonymize<Iabpgqcjikia83>>;
        /**
         * Returns a list of identifiers for available builtin `RuntimeGenesisConfig` presets.
         *
         * The presets from the list can be queried with [`GenesisBuilder::get_preset`] method. If
         * no named presets are provided by the runtime the list is empty.
         */
        preset_names: RuntimeDescriptor<[], Anonymize<I6lr8sctk0bi4e>>;
    };
};
export type HippiusDispatchError = Anonymize<Ik9f7r9ibbik9>;
type IAsset = PlainDescriptor<void>;
export type HippiusExtensions = {};
type PalletsTypedef = {
    __storage: IStorage;
    __tx: ICalls;
    __event: IEvent;
    __error: IError;
    __const: IConstants;
    __view: IViewFns;
};
export type Hippius = {
    descriptors: {
        pallets: PalletsTypedef;
        apis: IRuntimeCalls;
    } & Promise<any>;
    metadataTypes: Promise<Uint8Array>;
    asset: IAsset;
    extensions: HippiusExtensions;
    getMetadata: () => Promise<Uint8Array>;
    genesis: string | undefined;
};
declare const _allDescriptors: Hippius;
export default _allDescriptors;
export type HippiusApis = ApisFromDef<IRuntimeCalls>;
export type HippiusQueries = QueryFromPalletsDef<PalletsTypedef>;
export type HippiusCalls = TxFromPalletsDef<PalletsTypedef>;
export type HippiusEvents = EventsFromPalletsDef<PalletsTypedef>;
export type HippiusErrors = ErrorsFromPalletsDef<PalletsTypedef>;
export type HippiusConstants = ConstFromPalletsDef<PalletsTypedef>;
export type HippiusViewFns = ViewFnsFromPalletsDef<PalletsTypedef>;
export type HippiusCallData = Anonymize<If4gigsesqmr49> & {
    value: {
        type: string;
    };
};
type AllInteractions = {
    storage: {
        System: ['Account', 'ExtrinsicCount', 'InherentsApplied', 'BlockWeight', 'AllExtrinsicsLen', 'BlockHash', 'ExtrinsicData', 'Number', 'ParentHash', 'Digest', 'Events', 'EventCount', 'EventTopics', 'LastRuntimeUpgrade', 'UpgradedToU32RefCount', 'UpgradedToTripleRefCount', 'ExecutionPhase', 'AuthorizedUpgrade'];
        Timestamp: ['Now', 'DidUpdate'];
        Sudo: ['Key'];
        RandomnessCollectiveFlip: ['RandomMaterial'];
        Assets: ['Asset', 'Account', 'Approvals', 'Metadata', 'NextAssetId'];
        Balances: ['TotalIssuance', 'InactiveIssuance', 'Account', 'Locks', 'Reserves', 'Holds', 'Freezes'];
        TransactionPayment: ['NextFeeMultiplier', 'StorageVersion'];
        Authorship: ['Author'];
        Babe: ['EpochIndex', 'Authorities', 'GenesisSlot', 'CurrentSlot', 'Randomness', 'PendingEpochConfigChange', 'NextRandomness', 'NextAuthorities', 'SegmentIndex', 'UnderConstruction', 'Initialized', 'AuthorVrfRandomness', 'EpochStart', 'Lateness', 'EpochConfig', 'NextEpochConfig', 'SkippedEpochs'];
        Grandpa: ['State', 'PendingChange', 'NextForced', 'Stalled', 'CurrentSetId', 'SetIdSession', 'Authorities'];
        Indices: ['Accounts'];
        Democracy: ['PublicPropCount', 'PublicProps', 'DepositOf', 'ReferendumCount', 'LowestUnbaked', 'ReferendumInfoOf', 'VotingOf', 'LastTabledWasExternal', 'NextExternal', 'Blacklist', 'Cancellations', 'MetadataOf'];
        Council: ['Proposals', 'ProposalOf', 'Voting', 'ProposalCount', 'Members', 'Prime'];
        Vesting: ['Vesting', 'StorageVersion'];
        Elections: ['Members', 'RunnersUp', 'Candidates', 'ElectionRounds', 'Voting'];
        ElectionProviderMultiPhase: ['Round', 'CurrentPhase', 'QueuedSolution', 'Snapshot', 'DesiredTargets', 'SnapshotMetadata', 'SignedSubmissionNextIndex', 'SignedSubmissionIndices', 'SignedSubmissionsMap', 'MinimumUntrustedScore'];
        Staking: ['ValidatorCount', 'MinimumValidatorCount', 'Invulnerables', 'Bonded', 'MinNominatorBond', 'MinValidatorBond', 'MinimumActiveStake', 'MinCommission', 'Ledger', 'Payee', 'Validators', 'CounterForValidators', 'MaxValidatorsCount', 'Nominators', 'CounterForNominators', 'VirtualStakers', 'CounterForVirtualStakers', 'MaxNominatorsCount', 'CurrentEra', 'ActiveEra', 'ErasStartSessionIndex', 'ErasStakers', 'ErasStakersOverview', 'ErasStakersClipped', 'ErasStakersPaged', 'ClaimedRewards', 'ErasValidatorPrefs', 'ErasValidatorReward', 'ErasRewardPoints', 'ErasTotalStake', 'ForceEra', 'MaxStakedRewards', 'SlashRewardFraction', 'CanceledSlashPayout', 'UnappliedSlashes', 'BondedEras', 'ValidatorSlashInEra', 'NominatorSlashInEra', 'SlashingSpans', 'SpanSlash', 'CurrentPlannedSession', 'DisabledValidators', 'ChillThreshold'];
        Session: ['Validators', 'CurrentIndex', 'QueuedChanged', 'QueuedKeys', 'DisabledValidators', 'NextKeys', 'KeyOwner'];
        Historical: ['HistoricalSessions', 'StoredRange'];
        Treasury: ['ProposalCount', 'Proposals', 'Deactivated', 'Approvals', 'SpendCount', 'Spends'];
        Bounties: ['BountyCount', 'Bounties', 'BountyDescriptions', 'BountyApprovals'];
        ChildBounties: ['ChildBountyCount', 'ParentChildBounties', 'ChildBounties', 'ChildBountyDescriptions', 'ChildrenCuratorFees'];
        BagsList: ['ListNodes', 'CounterForListNodes', 'ListBags'];
        NominationPools: ['TotalValueLocked', 'MinJoinBond', 'MinCreateBond', 'MaxPools', 'MaxPoolMembers', 'MaxPoolMembersPerPool', 'GlobalMaxCommission', 'PoolMembers', 'CounterForPoolMembers', 'BondedPools', 'CounterForBondedPools', 'RewardPools', 'CounterForRewardPools', 'SubPoolsStorage', 'CounterForSubPoolsStorage', 'Metadata', 'CounterForMetadata', 'LastPoolId', 'ReversePoolIdLookup', 'CounterForReversePoolIdLookup', 'ClaimPermissions'];
        Scheduler: ['IncompleteSince', 'Agenda', 'Retries', 'Lookup'];
        Preimage: ['StatusFor', 'RequestStatusFor', 'PreimageFor'];
        Offences: ['Reports', 'ConcurrentReportsIndex'];
        TxPause: ['PausedCalls'];
        ImOnline: ['HeartbeatAfter', 'Keys', 'ReceivedHeartbeats', 'AuthoredBlocks'];
        Identity: ['IdentityOf', 'SuperOf', 'SubsOf', 'Registrars', 'UsernameAuthorities', 'AccountOfUsername', 'PendingUsernames'];
        Multisig: ['Multisigs'];
        Ethereum: ['Pending', 'CurrentBlock', 'CurrentReceipts', 'CurrentTransactionStatuses', 'BlockHash'];
        EVM: ['AccountCodes', 'AccountCodesMetadata', 'AccountStorages', 'Suicided', 'WhitelistedCreators'];
        EVMChainId: ['ChainId'];
        DynamicFee: ['MinGasPrice', 'TargetMinGasPrice'];
        BaseFee: ['BaseFeePerGas', 'Elasticity'];
        Proxy: ['Proxies', 'Announcements'];
        Registration: ['DisabledNodeTypes', 'ColdkeyNodeRegistration', 'BannedAccounts', 'ValidatorWhitelistEnabled', 'NodeLastDeregisteredAt', 'LinkedNodes', 'WhitelistedValidators', 'NodeRegistration', 'ReportSubmissionCount', 'TemporaryDeregistrationReports', 'FeeChargingEnabled', 'CurrentNodeTypeFee', 'LastRegistrationBlock', 'UsedChallenges', 'Libp2pMainIdentity', 'Libp2pIpfsIdentity', 'DeregistrationEnabled'];
        ExecutionUnit: ['BlockNumbers', 'NodeMetrics', 'PurgeDeregisteredNodesEnabled', 'TemporaryPinReports', 'RequestsCount', 'HardwareRequestsCount', 'TotalPinChecksPerEpoch', 'SuccessfulPinChecksPerEpoch', 'TotalPingChecksPerEpoch', 'SuccessfulPingChecksPerEpoch', 'HardwareRequestsLastBlock'];
        Metagraph: ['UIDs', 'ValidatorSubmissions', 'WhitelistedValidators', 'ValidatorTrustPoints', 'StoredDividends'];
        Marketplace: ['Plans', 'PricePerGbs', 'PricePerBandwidth', 'StorageLastChargedAt', 'UserPlanSubscriptions', 'UserAllSubscriptionPlans', 'OSDiskImageUrls', 'Batches', 'UserBatches', 'IsStorageOperationsEnabled', 'IsPurchasePlanEnabled', 'NextBatchId', 'CdnLocations', 'NextSubscriptionId', 'PointTransactions', 'NextTransactionId', 'BackupEnabledUsers', 'BackupDeleteRequests', 'SpecificMinerRequestFee', 'UserRequestsCount', 'SudoKey'];
        SubAccount: ['SubAccount', 'SubAccountRole'];
        Notifications: ['Notifications', 'BannedAccounts', 'LastCallTime'];
        AccountProfile: ['UserPublicStorage', 'DataPublicKeys', 'MessagePublicKeys', 'UserPrivateStorage', 'Usernames', 'AccountUsernames'];
        Utils: ['MetagraphSubmissionEnabled', 'WeightSubmissionEnabled'];
        RankingStorage: ['RankDistributionLimit', 'RankedList', 'LastGlobalUpdate', 'RewardsRecord'];
        RankingCompute: ['RankDistributionLimit', 'RankedList', 'LastGlobalUpdate', 'RewardsRecord'];
        RankingValidators: ['RankDistributionLimit', 'RankedList', 'LastGlobalUpdate', 'RewardsRecord'];
        Credits: ['Authorities', 'ReferralCodeRewards', 'ReferralCodeUsageCount', 'TotalReferralCodes', 'TotalSucessfullCreditsTransfers', 'LastReferralCreationBlock', 'TotalReferralRewards', 'ReferralCodes', 'ReferredUsers', 'TotalCreditsPurchased', 'AlphaBalances', 'FreeCredits', 'CurrentLockPeriod', 'AlphaPrice', 'MinLockAmount', 'LockedCredits'];
        ContainerRegistry: ['NextSpaceId', 'Spaces', 'ManifestDigests', 'DigestInfoStorage', 'ImageDigestToCid'];
        AlphaBridge: ['Guardians', 'ApproveThreshold', 'GlobalMintCap', 'TotalMintedByBridge', 'Paused', 'Deposits', 'WithdrawalRequests', 'NextWithdrawalRequestNonce', 'CleanupTTLBlocks', 'MinWithdrawalAmount'];
        PalletIp: ['AvailableHypervisorIps', 'AvailableClientIps', 'AvailableStorageMinerIps', 'VmAvailableIps', 'AssignedVmIps', 'AssignedClientIps', 'IpToRole', 'RoleToIp', 'IpReleaseRequests'];
        IpfsPallet: ['RequestsCount', 'CurrentEpochValidator', 'UserTotalFilesSize', 'MinerTotalFilesSize', 'MinerTotalFilesPinned', 'UserStorageRequests', 'BlacklistedUsers', 'UserUnpinRequests', 'ReputationPoints', 'RebalanceRequest', 'Blacklist', 'UnpinRequests', 'RotationWhitelistingEnabled', 'MinerProfile', 'UserProfile', 'PinningEnabled', 'AssignmentEnabled'];
        Arion: ['CurrentEpoch', 'EpochParams', 'EpochMiners', 'EpochRoot', 'CurrentStatsBucket', 'CurrentNetworkTotals', 'MinerStatsByUid', 'CurrentAttestationBucket', 'AttestationsByBucket', 'EpochAttestationCommitments', 'RegisteredWardens', 'ActiveWardenCount', 'LockupEnabled', 'BaseChildDepositValue', 'FamilyCount', 'FamilyUsedFreeSlot', 'FamilyActiveChildren', 'TotalActiveChildren', 'GlobalNextDeposit', 'GlobalLastPaidRegistrationBlock', 'ChildRegistrations', 'NodeIdToChild', 'NodeIdNonce', 'ChildCooldownUntil', 'NodeIdCooldownUntil', 'FamilyChildren', 'CurrentWeightBucket', 'NodeWeightByChild', 'NodeWeightLastBucket', 'NodeQualityByChild', 'FamilyWeightRaw', 'FamilyWeight', 'FamilyFirstSeenBucket'];
    };
    tx: {
        System: ['remark', 'set_heap_pages', 'set_code', 'set_code_without_checks', 'set_storage', 'kill_storage', 'kill_prefix', 'remark_with_event', 'authorize_upgrade', 'authorize_upgrade_without_checks', 'apply_authorized_upgrade'];
        Timestamp: ['set'];
        Sudo: ['sudo', 'sudo_unchecked_weight', 'set_key', 'sudo_as', 'remove_key'];
        Assets: ['create', 'force_create', 'start_destroy', 'destroy_accounts', 'destroy_approvals', 'finish_destroy', 'mint', 'burn', 'transfer', 'transfer_keep_alive', 'force_transfer', 'freeze', 'thaw', 'freeze_asset', 'thaw_asset', 'transfer_ownership', 'set_team', 'set_metadata', 'clear_metadata', 'force_set_metadata', 'force_clear_metadata', 'force_asset_status', 'approve_transfer', 'cancel_approval', 'force_cancel_approval', 'transfer_approved', 'touch', 'refund', 'set_min_balance', 'touch_other', 'refund_other', 'block'];
        Balances: ['transfer_allow_death', 'force_transfer', 'transfer_keep_alive', 'transfer_all', 'force_unreserve', 'upgrade_accounts', 'force_set_balance', 'force_adjust_total_issuance', 'burn'];
        Babe: ['report_equivocation', 'report_equivocation_unsigned', 'plan_config_change'];
        Grandpa: ['report_equivocation', 'report_equivocation_unsigned', 'note_stalled'];
        Indices: ['claim', 'transfer', 'free', 'force_transfer', 'freeze'];
        Democracy: ['propose', 'second', 'vote', 'emergency_cancel', 'external_propose', 'external_propose_majority', 'external_propose_default', 'fast_track', 'veto_external', 'cancel_referendum', 'delegate', 'undelegate', 'clear_public_proposals', 'unlock', 'remove_vote', 'remove_other_vote', 'blacklist', 'cancel_proposal', 'set_metadata'];
        Council: ['set_members', 'execute', 'propose', 'vote', 'disapprove_proposal', 'close'];
        Vesting: ['vest', 'vest_other', 'vested_transfer', 'force_vested_transfer', 'merge_schedules', 'force_remove_vesting_schedule'];
        Elections: ['vote', 'remove_voter', 'submit_candidacy', 'renounce_candidacy', 'remove_member', 'clean_defunct_voters'];
        ElectionProviderMultiPhase: ['submit_unsigned', 'set_minimum_untrusted_score', 'set_emergency_election_result', 'submit', 'governance_fallback'];
        Staking: ['bond', 'bond_extra', 'unbond', 'withdraw_unbonded', 'validate', 'nominate', 'chill', 'set_payee', 'set_controller', 'set_validator_count', 'increase_validator_count', 'scale_validator_count', 'force_no_eras', 'force_new_era', 'set_invulnerables', 'force_unstake', 'force_new_era_always', 'cancel_deferred_slash', 'payout_stakers', 'rebond', 'reap_stash', 'kick', 'set_staking_configs', 'chill_other', 'force_apply_min_commission', 'set_min_commission', 'payout_stakers_by_page', 'update_payee', 'deprecate_controller_batch', 'restore_ledger'];
        Session: ['set_keys', 'purge_keys'];
        Treasury: ['spend_local', 'remove_approval', 'spend', 'payout', 'check_status', 'void_spend'];
        Bounties: ['propose_bounty', 'approve_bounty', 'propose_curator', 'unassign_curator', 'accept_curator', 'award_bounty', 'claim_bounty', 'close_bounty', 'extend_bounty_expiry'];
        ChildBounties: ['add_child_bounty', 'propose_curator', 'accept_curator', 'unassign_curator', 'award_child_bounty', 'claim_child_bounty', 'close_child_bounty'];
        BagsList: ['rebag', 'put_in_front_of', 'put_in_front_of_other'];
        NominationPools: ['join', 'bond_extra', 'claim_payout', 'unbond', 'pool_withdraw_unbonded', 'withdraw_unbonded', 'create', 'create_with_pool_id', 'nominate', 'set_state', 'set_metadata', 'set_configs', 'update_roles', 'chill', 'bond_extra_other', 'set_claim_permission', 'claim_payout_other', 'set_commission', 'set_commission_max', 'set_commission_change_rate', 'claim_commission', 'adjust_pool_deposit', 'set_commission_claim_permission', 'apply_slash', 'migrate_delegation', 'migrate_pool_to_delegate_stake'];
        Scheduler: ['schedule', 'cancel', 'schedule_named', 'cancel_named', 'schedule_after', 'schedule_named_after', 'set_retry', 'set_retry_named', 'cancel_retry', 'cancel_retry_named'];
        Preimage: ['note_preimage', 'unnote_preimage', 'request_preimage', 'unrequest_preimage', 'ensure_updated'];
        TxPause: ['pause', 'unpause'];
        ImOnline: ['heartbeat'];
        Identity: ['add_registrar', 'set_identity', 'set_subs', 'clear_identity', 'request_judgement', 'cancel_request', 'set_fee', 'set_account_id', 'set_fields', 'provide_judgement', 'kill_identity', 'add_sub', 'rename_sub', 'remove_sub', 'quit_sub', 'add_username_authority', 'remove_username_authority', 'set_username_for', 'accept_username', 'remove_expired_approval', 'set_primary_username', 'remove_dangling_username'];
        Utility: ['batch', 'as_derivative', 'batch_all', 'dispatch_as', 'force_batch', 'with_weight'];
        Multisig: ['as_multi_threshold_1', 'as_multi', 'approve_as_multi', 'cancel_as_multi'];
        Ethereum: ['transact'];
        EVM: ['withdraw', 'call', 'create', 'create2', 'set_whitelist'];
        DynamicFee: ['note_min_gas_price_target'];
        BaseFee: ['set_base_fee_per_gas', 'set_elasticity'];
        HotfixSufficients: ['hotfix_inc_account_sufficients'];
        Proxy: ['proxy', 'add_proxy', 'remove_proxy', 'remove_proxies', 'create_pure', 'kill_pure', 'announce', 'remove_announcement', 'reject_announcement', 'proxy_announced'];
        Registration: ['force_register_coldkey_node', 'register_node_with_coldkey', 'set_node_status_to_degraded', 'set_fee_charging', 'set_node_type_fee', 'set_node_type_disabled', 'force_unregister_hotkey_node', 'force_unregister_coldkey_node', 'unregister_node', 'unregister_main_node', 'swap_node_owner', 'sudo_unregister_unverified_nodes', 'submit_deregistration_report', 'set_account_ban_status', 'set_whitelisted_validators', 'verify_existing_node', 'verify_existing_coldkey_node', 'set_deregistration_enabled'];
        ExecutionUnit: ['add_hardware_info', 'metrics_data_update', 'update_pin_check_metrics', 'sudo_enable_purge_deregistered_nodes', 'sudo_disable_purge_deregistered_nodes'];
        Metagraph: ['submit_hot_keys_info', 'set_stored_dividends', 'sudo_add_whitelisted_validator', 'sudo_remove_whitelisted_validator'];
        Marketplace: ['set_package_suspension', 'storage_request', 'storage_unpin_request', 'add_new_plan', 'purchase_plan', 'set_price_per_gb', 'set_bandwidth_price', 'set_os_disk_image_url', 'set_specific_miner_request_fee', 'deposit', 'chargeback', 'set_sudo_key', 'sudo_set_storage_operations', 'sudo_set_purchase_plan', 'cancel_my_subscription'];
        SubAccount: ['add_sub_account', 'remove_sub_account', 'update_sub_account_role'];
        Notifications: ['send_notification', 'mark_as_read', 'sudo_update_notification', 'ban_account'];
        AccountProfile: ['set_public_item', 'set_private_item', 'set_username', 'set_data_public_key', 'set_message_public_key'];
        Utils: ['set_metagraph_submission_enabled', 'set_weight_submission_enabled'];
        RankingStorage: ['update_rank_distribution_limit', 'update_rankings'];
        RankingCompute: ['update_rank_distribution_limit', 'update_rankings'];
        RankingValidators: ['update_rank_distribution_limit', 'update_rankings'];
        Credits: ['add_authority', 'remove_authority', 'burn', 'increase_user_balance', 'create_referral_code', 'change_referral_code', 'fulfill_locked_credits', 'set_lock_period', 'set_min_lock_amount', 'set_alpha_price'];
        ContainerRegistry: ['create_space', 'add_space_member', 'add_manifest_head_digest_and_manifest_json_cid', 'store_digest_info'];
        AlphaBridge: ['withdraw', 'attest_deposit', 'cleanup_deposit', 'cleanup_withdrawal_request', 'set_guardians_and_threshold', 'pause', 'unpause', 'set_global_mint_cap', 'set_cleanup_ttl', 'set_min_withdrawal_amount', 'admin_cancel_deposit', 'admin_fail_withdrawal_request', 'admin_manual_mint'];
        PalletIp: ['add_available_vm_ip', 'add_available_hypervisor_ip', 'add_available_client_ip', 'add_available_storage_miner_ip', 'remove_available_vm_ip', 'remove_available_hypervisor_ip', 'remove_available_client_ip', 'remove_available_storage_miner_ip'];
        IpfsPallet: ['set_pinning_enabled', 'set_assignment_enabled', 'remove_bad_storage_request', 'remove_bad_unpin_request', 'update_pin_and_storage_requests', 'update_unpin_and_storage_requests', 'sudo_remove_unpin_requests', 'remove_rebalance_request', 'blacklist_user', 'set_rotation_whitelisting_enabled', 'clear_all_data', 'update_miner_profiles', 'update_user_profiles', 'clear_all_unpin_requests', 'close_storage_requests', 'close_unpin_requests', 'submit_storage_request_for_user', 'submit_unpin_request_for_user'];
        Arion: ['submit_crush_map', 'submit_miner_stats', 'register_child', 'deregister_child', 'claim_unbonded', 'submit_node_quality', 'submit_attestations', 'submit_attestation_commitment', 'set_lockup_enabled', 'set_base_child_deposit', 'register_warden', 'deregister_warden', 'prune_attestation_buckets'];
    };
    events: {
        System: ['ExtrinsicSuccess', 'ExtrinsicFailed', 'CodeUpdated', 'NewAccount', 'KilledAccount', 'Remarked', 'UpgradeAuthorized'];
        Sudo: ['Sudid', 'KeyChanged', 'KeyRemoved', 'SudoAsDone'];
        Assets: ['Created', 'Issued', 'Transferred', 'Burned', 'TeamChanged', 'OwnerChanged', 'Frozen', 'Thawed', 'AssetFrozen', 'AssetThawed', 'AccountsDestroyed', 'ApprovalsDestroyed', 'DestructionStarted', 'Destroyed', 'ForceCreated', 'MetadataSet', 'MetadataCleared', 'ApprovedTransfer', 'ApprovalCancelled', 'TransferredApproved', 'AssetStatusChanged', 'AssetMinBalanceChanged', 'Touched', 'Blocked', 'Deposited', 'Withdrawn'];
        Balances: ['Endowed', 'DustLost', 'Transfer', 'BalanceSet', 'Reserved', 'Unreserved', 'ReserveRepatriated', 'Deposit', 'Withdraw', 'Slashed', 'Minted', 'Burned', 'Suspended', 'Restored', 'Upgraded', 'Issued', 'Rescinded', 'Locked', 'Unlocked', 'Frozen', 'Thawed', 'TotalIssuanceForced'];
        TransactionPayment: ['TransactionFeePaid'];
        Grandpa: ['NewAuthorities', 'Paused', 'Resumed'];
        Indices: ['IndexAssigned', 'IndexFreed', 'IndexFrozen'];
        Democracy: ['Proposed', 'Tabled', 'ExternalTabled', 'Started', 'Passed', 'NotPassed', 'Cancelled', 'Delegated', 'Undelegated', 'Vetoed', 'Blacklisted', 'Voted', 'Seconded', 'ProposalCanceled', 'MetadataSet', 'MetadataCleared', 'MetadataTransferred'];
        Council: ['Proposed', 'Voted', 'Approved', 'Disapproved', 'Executed', 'MemberExecuted', 'Closed'];
        Vesting: ['VestingUpdated', 'VestingCompleted'];
        Elections: ['NewTerm', 'EmptyTerm', 'ElectionError', 'MemberKicked', 'Renounced', 'CandidateSlashed', 'SeatHolderSlashed'];
        ElectionProviderMultiPhase: ['SolutionStored', 'ElectionFinalized', 'ElectionFailed', 'Rewarded', 'Slashed', 'PhaseTransitioned'];
        Staking: ['EraPaid', 'Rewarded', 'Slashed', 'SlashReported', 'OldSlashingReportDiscarded', 'StakersElected', 'Bonded', 'Unbonded', 'Withdrawn', 'Kicked', 'StakingElectionFailed', 'Chilled', 'PayoutStarted', 'ValidatorPrefsSet', 'SnapshotVotersSizeExceeded', 'SnapshotTargetsSizeExceeded', 'ForceEra', 'ControllerBatchDeprecated'];
        Session: ['NewSession'];
        Treasury: ['Spending', 'Awarded', 'Burnt', 'Rollover', 'Deposit', 'SpendApproved', 'UpdatedInactive', 'AssetSpendApproved', 'AssetSpendVoided', 'Paid', 'PaymentFailed', 'SpendProcessed'];
        Bounties: ['BountyProposed', 'BountyRejected', 'BountyBecameActive', 'BountyAwarded', 'BountyClaimed', 'BountyCanceled', 'BountyExtended', 'BountyApproved', 'CuratorProposed', 'CuratorUnassigned', 'CuratorAccepted'];
        ChildBounties: ['Added', 'Awarded', 'Claimed', 'Canceled'];
        BagsList: ['Rebagged', 'ScoreUpdated'];
        NominationPools: ['Created', 'Bonded', 'PaidOut', 'Unbonded', 'Withdrawn', 'Destroyed', 'StateChanged', 'MemberRemoved', 'RolesUpdated', 'PoolSlashed', 'UnbondingPoolSlashed', 'PoolCommissionUpdated', 'PoolMaxCommissionUpdated', 'PoolCommissionChangeRateUpdated', 'PoolCommissionClaimPermissionUpdated', 'PoolCommissionClaimed', 'MinBalanceDeficitAdjusted', 'MinBalanceExcessAdjusted'];
        Scheduler: ['Scheduled', 'Canceled', 'Dispatched', 'RetrySet', 'RetryCancelled', 'CallUnavailable', 'PeriodicFailed', 'RetryFailed', 'PermanentlyOverweight'];
        Preimage: ['Noted', 'Requested', 'Cleared'];
        Offences: ['Offence'];
        TxPause: ['CallPaused', 'CallUnpaused'];
        ImOnline: ['HeartbeatReceived', 'AllGood', 'SomeOffline'];
        Identity: ['IdentitySet', 'IdentityCleared', 'IdentityKilled', 'JudgementRequested', 'JudgementUnrequested', 'JudgementGiven', 'RegistrarAdded', 'SubIdentityAdded', 'SubIdentityRemoved', 'SubIdentityRevoked', 'AuthorityAdded', 'AuthorityRemoved', 'UsernameSet', 'UsernameQueued', 'PreapprovalExpired', 'PrimaryUsernameSet', 'DanglingUsernameRemoved'];
        Utility: ['BatchInterrupted', 'BatchCompleted', 'BatchCompletedWithErrors', 'ItemCompleted', 'ItemFailed', 'DispatchedAs'];
        Multisig: ['NewMultisig', 'MultisigApproval', 'MultisigExecuted', 'MultisigCancelled'];
        Ethereum: ['Executed'];
        EVM: ['Log', 'Created', 'CreatedFailed', 'Executed', 'ExecutedFailed'];
        BaseFee: ['NewBaseFeePerGas', 'BaseFeeOverflow', 'NewElasticity'];
        Proxy: ['ProxyExecuted', 'PureCreated', 'Announced', 'ProxyAdded', 'ProxyRemoved'];
        Registration: ['NodeRegistered', 'MainNodeRegistered', 'NodeUnregistered', 'NodeUnregisteredBatch', 'NodeStatusUpdated', 'FeeChargingStatusChanged', 'FeePercentageChanged', 'NodeTypeFeeUpdated', 'NodeTypeDisabledChanged', 'NodeOwnerSwapped', 'DeregistrationConsensusReached', 'DeregistrationConsensusFailed', 'AccountBanStatusChanged', 'WhitelistUpdated', 'NodeVerified', 'ColdkeyNodeVerified', 'DeregistrationStatusChanged'];
        ExecutionUnit: ['BenchmarkStarted', 'BenchmarkCompleted', 'BenchmarkFailed', 'NodeSpecsStored', 'SignedPayloadProcessed', 'PinCheckMetricsUpdated', 'PurgeDeregisteredNodesStatusChanged', 'StorageBelowTwoTB', 'NoPrimaryNetworkInterface', 'EmptyDisksArray', 'MemoryExceedsFiveTB', 'ConsensusReached', 'ConsensusFailed'];
        Metagraph: ['HotKeysUpdated', 'SignedPayloadProcessed', 'StorageUpdated', 'ValidatorTrustUpdated', 'WhitelistedValidatorAdded', 'WhitelistedValidatorRemoved'];
        Marketplace: ['CdnLocationAdded', 'AutoRenewalUpdated', 'SubscriptionTransferred', 'TokensBurned', 'PackageSuspensionSet', 'PinRequested', 'UnpinRequestAdded', 'StorageRequestAdded', 'StoragePlanPriceUpdated', 'ComputePlanPriceUpdated', 'PointTransactionRecorded', 'PlanPurchased', 'FileHashCleanedUp', 'PricePerGbUpdated', 'PricePerBandwidthUpdated', 'StorageSubscriptionCancelled', 'ComputeSubscriptionCancelled', 'BackupEnabled', 'BackupDisabled', 'OSDiskImageUrlSet', 'PlanPriceUpdated', 'SpecificMinerRequestFeeUpdated', 'BatchDeposited', 'CreditsConsumed', 'StorageOperationsStatusChanged', 'PurchasePlanStatusChanged'];
        SubAccount: ['SubAccountAdded', 'SubAccountRemoved', 'SubAccountRoleUpdated'];
        Notifications: ['NotificationSent', 'NotificationRead', 'SubscriptionHasEnded', 'SubscriptionEndingSoon', 'AccountBanned'];
        AccountProfile: ['PublicItemSet', 'PrivateItemSet', 'UsernameSet', 'DataPublicKeySet', 'MessagePublicKeySet'];
        RankingStorage: ['SomethingStored', 'RankingsUpdated', 'RewardDistributed', 'RankDistributionLimitUpdated'];
        RankingCompute: ['SomethingStored', 'RankingsUpdated', 'RewardDistributed', 'RankDistributionLimitUpdated'];
        RankingValidators: ['SomethingStored', 'RankingsUpdated', 'RewardDistributed', 'RankDistributionLimitUpdated'];
        Credits: ['MintedAccountCredits', 'BurnedAccountCredits', 'AuthorityAdded', 'AuthorityRemoved', 'ConvertedToCredits', 'CreditLocked', 'CreditFulfilled', 'AlphaPriceSet', 'MinLockAmountSet', 'ReferralDiscountApplied', 'ConvertedToAlpha', 'IncreasedUserBalance'];
        ContainerRegistry: ['SpaceCreated', 'MemberAdded', 'ManifestDigestUpdated', 'ImageDigestToCidStored', 'DigestInfoStored'];
        AlphaBridge: ['DepositAttested', 'DepositCompleted', 'DepositCancelled', 'WithdrawalRequestCreated', 'WithdrawalRequestFailed', 'AdminManualMint', 'Paused', 'Unpaused', 'GlobalMintCapUpdated', 'GuardiansUpdated', 'MinWithdrawalAmountUpdated', 'DepositCleanedUp', 'WithdrawalRequestCleanedUp', 'CleanupTTLUpdated'];
        PalletIp: ['IpAssigned', 'IpReturned', 'IpRetrieved', 'IpAdded', 'IpRemoved'];
        IpfsPallet: ['SomethingStored', 'StorageRequestUpdated', 'UnpinRequestCompleted', 'PinningEnabledChanged', 'MinerProfilesUpdated', 'StorageRequestsCleared', 'ReputationPointsUpdated', 'RotationStatusChanged', 'IpfsUnavailable', 'UserProfileUpdated', 'UsersProfilesUpdated', 'MinersProfilesUpdated', 'MinerProfileUpdated', 'ValidatorRotated', 'StorageRequestsClosed', 'UnpinRequestsClosed'];
        Arion: ['CrushMapPublished', 'MinerStatsUpdated', 'AttestationsSubmitted', 'AttestationCommitmentSubmitted', 'ChildRegistered', 'ChildDeregistered', 'ChildUnbonded', 'NodeWeightsUpdated', 'FamilyWeightsComputed', 'LockupEnabledSet', 'BaseChildDepositSet', 'WardenRegistered', 'WardenDeregistered', 'AttestationBucketsPruned'];
    };
    errors: {
        System: ['InvalidSpecName', 'SpecVersionNeedsToIncrease', 'FailedToExtractRuntimeVersion', 'NonDefaultComposite', 'NonZeroRefCount', 'CallFiltered', 'MultiBlockMigrationsOngoing', 'NothingAuthorized', 'Unauthorized'];
        Sudo: ['RequireSudo'];
        Assets: ['BalanceLow', 'NoAccount', 'NoPermission', 'Unknown', 'Frozen', 'InUse', 'BadWitness', 'MinBalanceZero', 'UnavailableConsumer', 'BadMetadata', 'Unapproved', 'WouldDie', 'AlreadyExists', 'NoDeposit', 'WouldBurn', 'LiveAsset', 'AssetNotLive', 'IncorrectStatus', 'NotFrozen', 'CallbackFailed', 'BadAssetId'];
        Balances: ['VestingBalance', 'LiquidityRestrictions', 'InsufficientBalance', 'ExistentialDeposit', 'Expendability', 'ExistingVestingSchedule', 'DeadAccount', 'TooManyReserves', 'TooManyHolds', 'TooManyFreezes', 'IssuanceDeactivated', 'DeltaZero'];
        Babe: ['InvalidEquivocationProof', 'InvalidKeyOwnershipProof', 'DuplicateOffenceReport', 'InvalidConfiguration'];
        Grandpa: ['PauseFailed', 'ResumeFailed', 'ChangePending', 'TooSoon', 'InvalidKeyOwnershipProof', 'InvalidEquivocationProof', 'DuplicateOffenceReport'];
        Indices: ['NotAssigned', 'NotOwner', 'InUse', 'NotTransfer', 'Permanent'];
        Democracy: ['ValueLow', 'ProposalMissing', 'AlreadyCanceled', 'DuplicateProposal', 'ProposalBlacklisted', 'NotSimpleMajority', 'InvalidHash', 'NoProposal', 'AlreadyVetoed', 'ReferendumInvalid', 'NoneWaiting', 'NotVoter', 'NoPermission', 'AlreadyDelegating', 'InsufficientFunds', 'NotDelegating', 'VotesExist', 'InstantNotAllowed', 'Nonsense', 'WrongUpperBound', 'MaxVotesReached', 'TooMany', 'VotingPeriodLow', 'PreimageNotExist'];
        Council: ['NotMember', 'DuplicateProposal', 'ProposalMissing', 'WrongIndex', 'DuplicateVote', 'AlreadyInitialized', 'TooEarly', 'TooManyProposals', 'WrongProposalWeight', 'WrongProposalLength', 'PrimeAccountNotMember'];
        Vesting: ['NotVesting', 'AtMaxVestingSchedules', 'AmountLow', 'ScheduleIndexOutOfBounds', 'InvalidScheduleParams'];
        Elections: ['UnableToVote', 'NoVotes', 'TooManyVotes', 'MaximumVotesExceeded', 'LowBalance', 'UnableToPayBond', 'MustBeVoter', 'DuplicatedCandidate', 'TooManyCandidates', 'MemberSubmit', 'RunnerUpSubmit', 'InsufficientCandidateFunds', 'NotMember', 'InvalidWitnessData', 'InvalidVoteCount', 'InvalidRenouncing', 'InvalidReplacement'];
        ElectionProviderMultiPhase: ['PreDispatchEarlySubmission', 'PreDispatchWrongWinnerCount', 'PreDispatchWeakSubmission', 'SignedQueueFull', 'SignedCannotPayDeposit', 'SignedInvalidWitness', 'SignedTooMuchWeight', 'OcwCallWrongEra', 'MissingSnapshotMetadata', 'InvalidSubmissionIndex', 'CallNotAllowed', 'FallbackFailed', 'BoundNotMet', 'TooManyWinners', 'PreDispatchDifferentRound'];
        Staking: ['NotController', 'NotStash', 'AlreadyBonded', 'AlreadyPaired', 'EmptyTargets', 'DuplicateIndex', 'InvalidSlashIndex', 'InsufficientBond', 'NoMoreChunks', 'NoUnlockChunk', 'FundedTarget', 'InvalidEraToReward', 'InvalidNumberOfNominations', 'NotSortedAndUnique', 'AlreadyClaimed', 'InvalidPage', 'IncorrectHistoryDepth', 'IncorrectSlashingSpans', 'BadState', 'TooManyTargets', 'BadTarget', 'CannotChillOther', 'TooManyNominators', 'TooManyValidators', 'CommissionTooLow', 'BoundNotMet', 'ControllerDeprecated', 'CannotRestoreLedger', 'RewardDestinationRestricted', 'NotEnoughFunds', 'VirtualStakerNotAllowed'];
        Session: ['InvalidProof', 'NoAssociatedValidatorId', 'DuplicatedKey', 'NoKeys', 'NoAccount'];
        Treasury: ['InvalidIndex', 'TooManyApprovals', 'InsufficientPermission', 'ProposalNotApproved', 'FailedToConvertBalance', 'SpendExpired', 'EarlyPayout', 'AlreadyAttempted', 'PayoutError', 'NotAttempted', 'Inconclusive'];
        Bounties: ['InsufficientProposersBalance', 'InvalidIndex', 'ReasonTooBig', 'UnexpectedStatus', 'RequireCurator', 'InvalidValue', 'InvalidFee', 'PendingPayout', 'Premature', 'HasActiveChildBounty', 'TooManyQueued'];
        ChildBounties: ['ParentBountyNotActive', 'InsufficientBountyBalance', 'TooManyChildBounties'];
        BagsList: ['List'];
        NominationPools: ['PoolNotFound', 'PoolMemberNotFound', 'RewardPoolNotFound', 'SubPoolsNotFound', 'AccountBelongsToOtherPool', 'FullyUnbonding', 'MaxUnbondingLimit', 'CannotWithdrawAny', 'MinimumBondNotMet', 'OverflowRisk', 'NotDestroying', 'NotNominator', 'NotKickerOrDestroying', 'NotOpen', 'MaxPools', 'MaxPoolMembers', 'CanNotChangeState', 'DoesNotHavePermission', 'MetadataExceedsMaxLen', 'Defensive', 'PartialUnbondNotAllowedPermissionlessly', 'MaxCommissionRestricted', 'CommissionExceedsMaximum', 'CommissionExceedsGlobalMaximum', 'CommissionChangeThrottled', 'CommissionChangeRateNotAllowed', 'NoPendingCommission', 'NoCommissionCurrentSet', 'PoolIdInUse', 'InvalidPoolId', 'BondExtraRestricted', 'NothingToAdjust', 'NothingToSlash', 'SlashTooLow', 'AlreadyMigrated', 'NotMigrated', 'NotSupported'];
        Scheduler: ['FailedToSchedule', 'NotFound', 'TargetBlockNumberInPast', 'RescheduleNoChange', 'Named'];
        Preimage: ['TooBig', 'AlreadyNoted', 'NotAuthorized', 'NotNoted', 'Requested', 'NotRequested', 'TooMany', 'TooFew', 'NoCost'];
        TxPause: ['IsPaused', 'IsUnpaused', 'Unpausable', 'NotFound'];
        ImOnline: ['InvalidKey', 'DuplicatedHeartbeat'];
        Identity: ['TooManySubAccounts', 'NotFound', 'NotNamed', 'EmptyIndex', 'FeeChanged', 'NoIdentity', 'StickyJudgement', 'JudgementGiven', 'InvalidJudgement', 'InvalidIndex', 'InvalidTarget', 'TooManyRegistrars', 'AlreadyClaimed', 'NotSub', 'NotOwned', 'JudgementForDifferentIdentity', 'JudgementPaymentFailed', 'InvalidSuffix', 'NotUsernameAuthority', 'NoAllocation', 'InvalidSignature', 'RequiresSignature', 'InvalidUsername', 'UsernameTaken', 'NoUsername', 'NotExpired'];
        Utility: ['TooManyCalls'];
        Multisig: ['MinimumThreshold', 'AlreadyApproved', 'NoApprovalsNeeded', 'TooFewSignatories', 'TooManySignatories', 'SignatoriesOutOfOrder', 'SenderInSignatories', 'NotFound', 'NotOwner', 'NoTimepoint', 'WrongTimepoint', 'UnexpectedTimepoint', 'MaxWeightTooLow', 'AlreadyStored'];
        Ethereum: ['InvalidSignature', 'PreLogExists'];
        EVM: ['BalanceLow', 'FeeOverflow', 'PaymentOverflow', 'WithdrawFailed', 'GasPriceTooLow', 'InvalidNonce', 'GasLimitTooLow', 'GasLimitTooHigh', 'InvalidChainId', 'InvalidSignature', 'Reentrancy', 'TransactionMustComeFromEOA', 'Undefined', 'NotAllowed'];
        HotfixSufficients: ['MaxAddressCountExceeded'];
        Proxy: ['TooMany', 'NotFound', 'NotProxy', 'Unproxyable', 'Duplicate', 'NoPermission', 'Unannounced', 'NoSelfProxy'];
        Registration: ['NoneValue', 'StorageOverflow', 'IpfsNodeIdRequired', 'NodeAlreadyRegistered', 'NodeNotFound', 'NotAminer', 'IpfsNodeIdAlreadyRegistered', 'AddressUidNotFoundOnBittensor', 'InvalidAccountId', 'InsufficientStake', 'InsufficientBalanceForFee', 'FeeTooHigh', 'NodeTypeDisabled', 'NodeTypeMismatch', 'NodeNotRegistered', 'NotNodeOwner', 'NotAProxyAccount', 'InvalidProxyType', 'AccountNotRegistered', 'NodeNotInUids', 'NodeCooldownPeriodNotExpired', 'OwnerAlreadyRegistered', 'InvalidNodeType', 'NodeNotDegradedStorageMiner', 'TooManyRequests', 'AccountBanned', 'ExceededMaxWhitelistedValidators', 'NodeNotWhitelisted', 'InvalidSignature', 'InvalidKeyType', 'InvalidChallenge', 'InvalidChallengeDomain', 'ChallengeExpired', 'ChallengeReused', 'GenesisMismatch', 'PublicKeyMismatch', 'ChallengeMismatch', 'TooManyUnverifiedNodes', 'NodeAlreadyVerified', 'Unauthorized'];
        ExecutionUnit: ['MetricsNotFound', 'InvalidJson', 'InvalidCid', 'StorageOverflow', 'IpfsError', 'TooManyRequests', 'NodeNotRegistered', 'InvalidNodeType', 'StorageBelowTwoTB', 'NoPrimaryNetworkInterface', 'EmptyDisksArray', 'MemoryExceedsFiveTB', 'ConsensusNotReached', 'SuccessfulPinsExceedTotal'];
        Metagraph: ['NoneValue', 'StorageOverflow', 'SigningError', 'InvalidSignature', 'InvalidUIDFormat', 'DecodingError', 'ValidatorAlreadyWhitelisted', 'ValidatorNotWhitelisted', 'NotWhitelistedValidator', 'NodeNotRegistered', 'InvalidNodeType'];
        Marketplace: ['NoneValue', 'NotSubscriptionOwner', 'SubscriptionNotFound', 'TooManySharedUsers', 'InsufficientPermissions', 'CannotTransferToSelf', 'RecipientTooManySubscriptions', 'CannotModifyOwnerPermissions', 'CannotTransferInactiveSubscription', 'AlreadyHasAccess', 'NoExistingAccess', 'NotAuthorized', 'InsufficientBalance', 'PackageNotFound', 'SubscriptionNotActive', 'InvalidSubscriptionType', 'StorageLimitExceeded', 'StorageRequestNotFound', 'PlanNotFound', 'InvalidPlanType', 'AlreadyHasActiveSubscription', 'PlanSuspended', 'InsufficientFreeCredits', 'LocationNotFound', 'InvalidPlanLimits', 'NodeTypeDisabled', 'InvalidStorageReduction', 'InvalidSubscriptionUsage', 'ComputeResourceExceeded', 'NoActiveSubscription', 'BackupAlreadyEnabled', 'InvalidImageSelection', 'NodeNotRegistered', 'InvalidNodeType', 'NoActiveComputeSubscription', 'InvalidPlanForSubscription', 'InvalidPlanConfiguration', 'InvalidOSDiskImageUrl', 'NoSubscriptionFound', 'StorageOperationsDisabled', 'PlanOperationDisabled', 'TooManyRequests', 'OperationNotAllowed'];
        Bittensor: ['NoneValue', 'StorageOverflow', 'SubmissionDisabled'];
        SubAccount: ['NoSubAccount', 'NotAllowed', 'NoAccountsLeft', 'AlreadySubAccount', 'MainCannotBeSubAccount', 'CannotBeOwnSubAccount', 'TooManySubAccounts', 'InvalidRoleChange'];
        Notifications: ['NoNotifications', 'InvalidNotificationIndex', 'CooldownNotElapsed', 'AccountBanned'];
        AccountProfile: ['InvalidHexString', 'UsernameAlreadySet', 'UsernameAlreadyTaken'];
        Utils: ['NoneValue', 'StorageOverflow'];
        RankingStorage: ['NoneValue', 'StorageOverflow', 'InvalidInput', 'ConversionError', 'NoSignerAvailable', 'CannotAcquireLock', 'NodeNotRegistered', 'InvalidNodeType'];
        RankingCompute: ['NoneValue', 'StorageOverflow', 'InvalidInput', 'ConversionError', 'NoSignerAvailable', 'CannotAcquireLock', 'NodeNotRegistered', 'InvalidNodeType'];
        RankingValidators: ['NoneValue', 'StorageOverflow', 'InvalidInput', 'ConversionError', 'NoSignerAvailable', 'CannotAcquireLock', 'NodeNotRegistered', 'InvalidNodeType'];
        Credits: ['NoneValue', 'StorageOverflow', 'InsufficientFreeCredits', 'UserNotFound', 'InsufficientLockedCredits', 'NotAuthorized', 'AuthorityAlreadyExists', 'AuthorityNotFound', 'InvalidConversionAmount', 'InsufficientBalance', 'ConversionFailed', 'InvalidReferralCode', 'ReferralCodeCooldown', 'NoReferralCodeUsed', 'InvalidRefferalOwner', 'CreditAlreadyFulfilled', 'LockedCreditNotFound', 'OutsideLockPeriod', 'NoActiveLockPeriod', 'InvalidLockPeriod', 'MinLockAmountNotSet', 'InsufficientLockAmount', 'InsufficientAlphaBalance'];
        ContainerRegistry: ['RepositoryAlreadyExists', 'MaxTagsLimitReached', 'ExceedsMaxLength', 'RepositoryNotFound', 'MaxImageCidsLimitReached', 'SpaceAlreadyExists', 'SpaceNotFound', 'NotAuthorized', 'MaxSpaceMembersReached', 'EmptyImageName', 'EmptyDigest', 'EmptyCid', 'EmptyDigestInfo', 'EmptyCidInfo', 'NotSpaceMember', 'SpaceDoesNotExist', 'NotSpaceOwner', 'UserAlreadyHasSpace'];
        AlphaBridge: ['NotGuardian', 'AlreadyVoted', 'InsufficientBalance', 'CapExceeded', 'BridgePaused', 'DepositNotFound', 'WithdrawalRequestNotFound', 'InvalidStatus', 'ThresholdTooLow', 'ThresholdTooHigh', 'TooManyGuardians', 'AmountConversionFailed', 'MintFailed', 'ArithmeticOverflow', 'DepositAlreadyCompleted', 'WithdrawalRequestAlreadyFinalized', 'AmountTooSmall', 'AccountingUnderflow', 'RecordNotFinalized', 'TTLNotExpired', 'InvalidTTL', 'InvalidRequestId', 'AmountNotBridgeable'];
        PalletIp: ['NoAvailableIp', 'VmAlreadyHasIp', 'VmHasNoIp', 'IpAlreadyExists', 'RoleAlreadyHasIp'];
        IpfsPallet: ['NoneValue', 'StorageOverflow', 'RequestDoesNotExists', 'OwnerNotFound', 'TooManyUnpinRequests', 'InvalidInput', 'RequestAlreadyExists', 'TooManyRequests', 'ValidatorSelectionFailed', 'NoValidatorsAvailable', 'NodeNotRegistered', 'NodeNotValidator', 'InvalidCid', 'InvalidJson', 'IpfsError', 'MaxUnpinRequestsExceeded', 'InvalidNodeType', 'MinerNotLocked', 'AssignmentNotEnabled', 'StorageRequestsCleared', 'FileHashBlacklisted', 'MinersNotLocked', 'UnauthorizedLocker', 'MinersAlreadyLocked', 'NodeIdTooLong', 'RequestNotFound', 'InvalidReputationPoints', 'UserIsBlacklisted', 'InvalidAccountId', 'NotCurrentEpochValidator', 'FileSizeOverflow', 'NotAuthorized', 'StorageRequestFailed'];
        Arion: ['EpochRegression', 'EpochAlreadyExists', 'MinerListNotSortedOrNotUnique', 'TooManyMiners', 'TooManyStatsUpdates', 'StatsBucketRegression', 'FamilyNotRegistered', 'ProxyVerificationFailed', 'TooManyFamilies', 'TooManyChildrenTotal', 'TooManyChildrenInFamily', 'ChildAlreadyRegistered', 'ChildNotRegistered', 'ChildInCooldown', 'NodeIdAlreadyRegistered', 'NodeIdInCooldown', 'InvalidNodeSignature', 'ChildNotActive', 'NotUnbonding', 'UnbondingNotReady', 'InsufficientDeposit', 'MinerNotRegistered', 'WeightBucketRegression', 'TooManyNodeWeightUpdates', 'AttestationBucketRegression', 'TooManyAttestations', 'AttestationBucketFull', 'InvalidAttestationSignature', 'AttestationCommitmentAlreadyExists', 'InvalidContentHashLength', 'WardenAlreadyRegistered', 'WardenNotRegistered', 'UnregisteredWarden', 'PruningWithinRetentionPeriod'];
    };
    constants: {
        System: ['BlockWeights', 'BlockLength', 'BlockHashCount', 'DbWeight', 'Version', 'SS58Prefix'];
        Timestamp: ['MinimumPeriod'];
        Assets: ['RemoveItemsLimit', 'AssetDeposit', 'AssetAccountDeposit', 'MetadataDepositBase', 'MetadataDepositPerByte', 'ApprovalDeposit', 'StringLimit'];
        Balances: ['ExistentialDeposit', 'MaxLocks', 'MaxReserves', 'MaxFreezes'];
        TransactionPayment: ['OperationalFeeMultiplier'];
        Babe: ['EpochDuration', 'ExpectedBlockTime', 'MaxAuthorities', 'MaxNominators'];
        Grandpa: ['MaxAuthorities', 'MaxNominators', 'MaxSetIdSessionEntries'];
        Indices: ['Deposit'];
        Democracy: ['EnactmentPeriod', 'LaunchPeriod', 'VotingPeriod', 'VoteLockingPeriod', 'MinimumDeposit', 'InstantAllowed', 'FastTrackVotingPeriod', 'CooloffPeriod', 'MaxVotes', 'MaxProposals', 'MaxDeposits', 'MaxBlacklisted'];
        Council: ['MaxProposalWeight'];
        Vesting: ['MinVestedTransfer', 'MaxVestingSchedules'];
        Elections: ['PalletId', 'CandidacyBond', 'VotingBondBase', 'VotingBondFactor', 'DesiredMembers', 'DesiredRunnersUp', 'TermDuration', 'MaxCandidates', 'MaxVoters', 'MaxVotesPerVoter'];
        ElectionProviderMultiPhase: ['BetterSignedThreshold', 'OffchainRepeat', 'MinerTxPriority', 'SignedMaxSubmissions', 'SignedMaxWeight', 'SignedMaxRefunds', 'SignedRewardBase', 'SignedDepositByte', 'SignedDepositWeight', 'MaxWinners', 'MinerMaxLength', 'MinerMaxWeight', 'MinerMaxVotesPerVoter', 'MinerMaxWinners'];
        Staking: ['HistoryDepth', 'SessionsPerEra', 'BondingDuration', 'SlashDeferDuration', 'MaxExposurePageSize', 'MaxUnlockingChunks'];
        Treasury: ['SpendPeriod', 'Burn', 'PalletId', 'MaxApprovals', 'PayoutPeriod'];
        Bounties: ['BountyDepositBase', 'BountyDepositPayoutDelay', 'BountyUpdatePeriod', 'CuratorDepositMultiplier', 'CuratorDepositMax', 'CuratorDepositMin', 'BountyValueMinimum', 'DataDepositPerByte', 'MaximumReasonLength'];
        ChildBounties: ['MaxActiveChildBountyCount', 'ChildBountyValueMinimum'];
        BagsList: ['BagThresholds'];
        NominationPools: ['PalletId', 'MaxPointsToBalance', 'MaxUnbonding'];
        Scheduler: ['MaximumWeight', 'MaxScheduledPerBlock'];
        TxPause: ['MaxNameLen'];
        ImOnline: ['UnsignedPriority'];
        Identity: ['BasicDeposit', 'ByteDeposit', 'SubAccountDeposit', 'MaxSubAccounts', 'MaxRegistrars', 'PendingUsernameExpiration', 'MaxSuffixLength', 'MaxUsernameLength'];
        Utility: ['batched_calls_limit'];
        Multisig: ['DepositBase', 'DepositFactor', 'MaxSignatories'];
        Proxy: ['ProxyDepositBase', 'ProxyDepositFactor', 'MaxProxies', 'MaxPending', 'AnnouncementDepositBase', 'AnnouncementDepositFactor'];
        Registration: ['MinerStakeThreshold', 'ChainDecimals', 'PalletId', 'StorageMinerInitialFee', 'ValidatorInitialFee', 'ComputeMinerInitialFee', 'GpuMinerInitialFee', 'StorageMiners3InitialFee', 'BlocksPerDay', 'NodeCooldownPeriod', 'MaxDeregRequestsPerPeriod', 'ConsensusThreshold', 'EpochDuration', 'ReportRequestsClearInterval'];
        ExecutionUnit: ['LocalRpcUrl', 'SystemInfoRpcMethod', 'GetReadProofRpcMethod', 'SystemHealthRpcMethod', 'UnregistrationBuffer', 'MaxOffchainRequestsPerPeriod', 'RequestsClearInterval', 'MaxOffchainHardwareSubmitRequestsPerPeriod', 'HardwareSubmitRequestsClearInterval', 'IpfsServiceUrl', 'LocalDefaultSpecVersion', 'LocalDefaultGenesisHash', 'ConsensusThreshold', 'ConsensusSimilarityThreshold', 'EpochDuration', 'ReputationUpdateInterval'];
        Metagraph: ['FinneyUrl', 'UidsStorageKey', 'DividendsStorageKey', 'UidsSubmissionInterval'];
        Marketplace: ['MinSubscriptionBlocks', 'MaxActiveSubscriptions', 'PalletId', 'BlockDurationMillis', 'BlocksPerHour', 'BlocksPerEra', 'StorageGracePeriod', 'ComputeGracePeriod', 'MaxRequestsPerBlock'];
        Bittensor: ['FinneyRpcUrl', 'VersionKeyStorageKey', 'BittensorCallSubmission', 'NetUid', 'Versionkey', 'DefaultSpecVersion', 'DefaultGenesisHash'];
        SubAccount: ['StringLimit', 'MaxSubAccountsLimit'];
        Notifications: ['CooldownPeriod'];
        Utils: ['LocalRpcUrl', 'RpcMethod'];
        RankingStorage: ['PalletId', 'ComputeNodesRewardPercentage', 'MinerNodesRewardPercentage', 'InstanceID', 'BlocksPerEra', 'LocalDefaultSpecVersion', 'LocalDefaultGenesisHash', 'LocalRpcUrl'];
        RankingCompute: ['PalletId', 'ComputeNodesRewardPercentage', 'MinerNodesRewardPercentage', 'InstanceID', 'BlocksPerEra', 'LocalDefaultSpecVersion', 'LocalDefaultGenesisHash', 'LocalRpcUrl'];
        RankingValidators: ['PalletId', 'ComputeNodesRewardPercentage', 'MinerNodesRewardPercentage', 'InstanceID', 'BlocksPerEra', 'LocalDefaultSpecVersion', 'LocalDefaultGenesisHash', 'LocalRpcUrl'];
        Credits: ['RefferallCoolDOwnPeriod'];
        ContainerRegistry: ['MaxLength'];
        AlphaBridge: ['PalletId'];
        IpfsPallet: ['IPFSBaseUrl', 'GarbageCollectorInterval', 'PinPinningInterval', 'MaxOffchainRequestsPerPeriod', 'RequestsClearInterval', 'EpochPeriod'];
        Arion: ['EnforceRegisteredMinersInMap', 'MaxMiners', 'MaxEndpointLen', 'MaxHttpAddrLen', 'MaxStatsUpdates', 'MaxAttestations', 'MaxShardHashLen', 'MaxWardenPubkeyLen', 'MaxSignatureLen', 'MaxMerkleProofLen', 'MaxWardenIdLen', 'MaxContentHashLen', 'AttestationRetentionBuckets', 'MaxFamilies', 'MaxChildrenTotal', 'MaxChildrenPerFamily', 'BaseChildDeposit', 'GlobalDepositHalvingPeriodBlocks', 'UnregisterCooldownBlocks', 'UnbondingPeriodBlocks', 'MaxNodeWeightUpdates', 'MaxNodeWeight', 'MaxFamilyWeight', 'FamilyTopN', 'FamilyRankDecayPermille', 'FamilyWeightEmaAlphaPermille', 'MaxFamilyWeightDeltaPerBucket', 'NewcomerGraceBuckets', 'NewcomerFloorWeight', 'NodeBandwidthWeightPermille', 'NodeStorageWeightPermille', 'NodeScoreScale', 'StrikePenalty', 'IntegrityFailPenalty'];
    };
    viewFns: {};
    apis: {
        Core: ['version', 'execute_block', 'initialize_block'];
        Metadata: ['metadata', 'metadata_at_version', 'metadata_versions'];
        BlockBuilder: ['apply_extrinsic', 'finalize_block', 'inherent_extrinsics', 'check_inherents'];
        EthereumRuntimeRPCApi: ['chain_id', 'account_basic', 'gas_price', 'account_code_at', 'author', 'storage_at', 'call', 'create', 'current_block', 'current_receipts', 'current_transaction_statuses', 'current_all', 'extrinsic_filter', 'elasticity', 'gas_limit_multiplier_support', 'pending_block', 'initialize_pending_block'];
        ConvertTransactionRuntimeApi: ['convert_transaction'];
        TaggedTransactionQueue: ['validate_transaction'];
        OffchainWorkerApi: ['offchain_worker'];
        SessionKeys: ['generate_session_keys', 'decode_session_keys'];
        BabeApi: ['configuration', 'current_epoch_start', 'current_epoch', 'next_epoch', 'generate_key_ownership_proof', 'submit_report_equivocation_unsigned_extrinsic'];
        AccountNonceApi: ['account_nonce'];
        TransactionPaymentApi: ['query_info', 'query_fee_details', 'query_weight_to_fee', 'query_length_to_fee'];
        GrandpaApi: ['grandpa_authorities', 'submit_report_equivocation_unsigned_extrinsic', 'generate_key_ownership_proof', 'current_set_id'];
        DebugRuntimeApi: ['trace_transaction', 'trace_block', 'trace_call'];
        NodeMetricsRuntimeApi: ['get_active_nodes_metrics_by_type', 'get_total_distributed_rewards_by_node_type', 'get_total_node_rewards', 'get_miners_total_rewards', 'get_account_pending_rewards', 'get_miners_pending_rewards', 'calculate_total_file_size', 'get_user_files', 'get_node_metrics', 'get_client_ip', 'get_hypervisor_ip', 'get_vm_ip', 'get_storage_miner_ip', 'get_miner_info', 'get_batches_for_user', 'get_batch_by_id', 'get_free_credits_rpc', 'get_referred_users', 'get_referral_rewards', 'total_referral_codes', 'total_referral_rewards', 'get_referral_codes', 'total_file_size_fulfilled'];
        TxPoolRuntimeApi: ['extrinsic_filter'];
        GenesisBuilder: ['build_state', 'get_preset', 'preset_names'];
    };
};
export type HippiusWhitelistEntry = PalletKey | `query.${NestedKey<AllInteractions['storage']>}` | `tx.${NestedKey<AllInteractions['tx']>}` | `event.${NestedKey<AllInteractions['events']>}` | `error.${NestedKey<AllInteractions['errors']>}` | `const.${NestedKey<AllInteractions['constants']>}` | `view.${NestedKey<AllInteractions['viewFns']>}` | `api.${NestedKey<AllInteractions['apis']>}`;
type PalletKey = `*.${({
    [K in keyof AllInteractions]: K extends 'apis' ? never : keyof AllInteractions[K];
})[keyof AllInteractions]}`;
type NestedKey<D extends Record<string, string[]>> = "*" | {
    [P in keyof D & string]: `${P}.*` | `${P}.${D[P][number]}`;
}[keyof D & string];
