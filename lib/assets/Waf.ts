import {ApplicationLoadBalancer} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import {aws_wafregional as wafregional} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import {config} from '../utils/config';

interface WafRule {
  name: string;
  rule: wafv2.CfnWebACL.RuleProperty;
}

const awsManagedRules: WafRule[] = [
  // AWS IP Reputation list includes known malicious actors/bots and is regularly updated
  {
    name: 'AWS-AWSManagedRulesAmazonIpReputationList',
    rule: {
      name: 'AWS-AWSManagedRulesAmazonIpReputationList',
      priority: 3,
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name: 'AWSManagedRulesAmazonIpReputationList',
        },
      },
      overrideAction: {
        none: {},
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'AWSManagedRulesAmazonIpReputationList',
      },
    },
  },
  // Common Rule Set aligns with major portions of OWASP Core Rule Set
  {
    name: 'AWS-AWSManagedRulesCommonRuleSet',
    rule: {
      name: 'AWS-AWSManagedRulesCommonRuleSet',
      priority: 4,
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name: 'AWSManagedRulesCommonRuleSet',
          // Excluding generic RFI body rule for sns notifications
          // https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html
          excludedRules: [
            {name: 'GenericRFI_BODY'},
            {name: 'SizeRestrictions_BODY'},
          ],
        },
      },
      overrideAction: {
        none: {},
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'AWS-AWSManagedRulesCommonRuleSet',
      },
    },
  },
  // Blocks attacks targeting LFI(Local File Injection) for linux systems
  {
    name: 'AWSManagedRuleLinux',
    rule: {
      name: 'AWSManagedRuleLinux',
      priority: 5,
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'AWSManagedRuleLinux',
      },
      overrideAction: {
        none: {},
      },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name: 'AWSManagedRulesLinuxRuleSet',
          excludedRules: [],
        },
      },
    },
  },
];

interface CustomStackProps extends cdk.StackProps {
  albs: ApplicationLoadBalancer[];
  cognitoUserPools: cognito.UserPool[];
}

export class Waf {
  public readonly rules:
    | cdk.IResolvable
    | (cdk.IResolvable | wafv2.CfnWebACL.RuleProperty)[]
    | undefined;

  public readonly regionalWebACL: wafv2.CfnWebACL;

  constructor(scope: Construct, props: CustomStackProps) {
    this.rules = awsManagedRules.map(wafRule => wafRule.rule);

    const allowedIpSet = new wafv2.CfnIPSet(scope, `AllowedIpSet`, {
      description: 'List of allowed IPs',
      ipAddressVersion: 'IPV4',
      addresses: ['179.27.81.176/29', '201.217.146.152/29'],
      scope: 'REGIONAL',
    });

    const allowedPathSetStateProp: wafv2.CfnWebACL.StatementProperty = {
      regexMatchStatement: {
        fieldToMatch: {
          uriPath: {},
        },
        regexString: '/api*',
        textTransformations: [
          {
            type: 'NONE',
            priority: 0,
          },
        ],
      },
    };

    const allowPathRule: wafv2.CfnRuleGroup.RuleProperty = {
      name: 'AllowedPathRule',
      priority: 0,
      action: {
        allow: {}, // To disable, change to *count*
      },
      statement: allowedPathSetStateProp,
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'AllowedPathSetMetric',
      },
    };
    this.rules.push(allowPathRule);

    const allowedIpSetStateProp: wafv2.CfnWebACL.StatementProperty = {
      ipSetReferenceStatement: {arn: allowedIpSet.attrArn},
    };
    const allowIpsRule: wafv2.CfnRuleGroup.RuleProperty = {
      name: 'AllowedIpsSet',
      priority: 1,
      action: {
        allow: {}, // To disable, change to *count*
      },
      statement: allowedIpSetStateProp,
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'AllowedIpsSetMetric',
      },
    };
    this.rules.push(allowIpsRule);

    // TODO: You can create the rule, but you can't associate it with an ACL through AWS CloudFormation.
    new wafregional.CfnRateBasedRule(scope, `MyCfnRateBasedRule`, {
      metricName: 'GenericIPSetRateBasedRule',
      name: 'GenericIPSetRateBasedRule',
      rateKey: 'IP',
      /**
       * The maximum number of requests, which have an identical value in the field specified by the RateKey,
       * allowed in a five-minute period. If the number of requests exceeds the RateLimit and the other
       * predicates specified in the rule are also met, AWS WAF triggers the action that is specified for this rule.
       */
      rateLimit: 8000,
    });

    this.regionalWebACL = new wafv2.CfnWebACL(scope, `WafRegional`, {
      defaultAction: {block: {}},
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'waf-regional',
        sampledRequestsEnabled: true,
      },
      description: 'WAFv2 ACL',
      name: `${config.PROJECT_NAME}-waf-regional`,
      customResponseBodies: {
        AccessDeniedErrorJson: {
          content: '{"error":"access denied"}',
          contentType: 'APPLICATION_JSON',
        },
      },
      rules: this.rules,
    });

    const aclLogGroup = new logs.LogGroup(scope, `ACLLogs`, {
      logGroupName: `aws-waf-logs-${this.regionalWebACL.attrId}`,
      retention: logs.RetentionDays.INFINITE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new wafv2.CfnLoggingConfiguration(scope, `ebAclLogging`, {
      logDestinationConfigs: [aclLogGroup.logGroupArn],
      resourceArn: this.regionalWebACL.attrArn,
    });

    props.albs.forEach((alb, i) => {
      new wafv2.CfnWebACLAssociation(scope, `LoadbalancerAssociation${i}`, {
        resourceArn: alb.loadBalancerArn,
        webAclArn: this.regionalWebACL.attrArn,
      });
    });

    props.cognitoUserPools.forEach((userPool, i) => {
      new wafv2.CfnWebACLAssociation(scope, `UserPoolAssociation${i}`, {
        resourceArn: userPool.userPoolArn,
        webAclArn: this.regionalWebACL.attrArn,
      });
    });
  }
}
